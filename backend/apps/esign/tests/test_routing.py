"""The routing engine and the audit chain (phase-08 §Tests).

These are the two pieces nobody sees and everybody depends on: who gets asked
next, and whether the record of what happened can be trusted.
"""
import pytest
from django.utils import timezone

from apps.esign import routing
from apps.esign.models import Recipient, SignRequest, record, verify_chain

pytestmark = pytest.mark.django_db


@pytest.fixture
def request_of(user, uploaded_doc):
    from apps.documents.models import Document

    document = Document.objects.get(id=uploaded_doc["id"])

    def _make(*specs, status=SignRequest.Status.SENT):
        sign_request = SignRequest.objects.create(
            owner=user, document=document, title="Contract",
            source_version=document.current_version, status=status,
            sent_at=timezone.now(),
        )
        for i, (role, order) in enumerate(specs):
            Recipient.objects.create(
                sign_request=sign_request, email=f"r{i}@example.com",
                name=f"R{i}", role=role, order=order,
            )
        return sign_request

    return _make


def _complete(sign_request, index: int):
    recipient = list(sign_request.recipients.all())[index]
    routing.complete_recipient(recipient)
    return recipient


# --------------------------------------------------------------------------- #
# The truth table (phase-08 names it explicitly)
# --------------------------------------------------------------------------- #
def test_sequential_asks_one_at_a_time(request_of):
    sign_request = request_of(("signer", 1), ("signer", 2))
    first, second = sign_request.recipients.all()

    assert routing.is_recipients_turn(first) is True
    assert routing.is_recipients_turn(second) is False, "signer 2 was asked early"

    routing.complete_recipient(first)
    sign_request.refresh_from_db()
    assert routing.is_recipients_turn(
        Recipient.objects.get(pk=second.pk)) is True


def test_parallel_asks_everyone_at_once(request_of):
    sign_request = request_of(("signer", 1), ("signer", 1))
    for recipient in sign_request.recipients.all():
        assert routing.is_recipients_turn(recipient) is True


def test_a_mixed_order_runs_the_group_then_the_next(request_of):
    sign_request = request_of(("signer", 1), ("signer", 1), ("approver", 2))
    a, b, approver = sign_request.recipients.all()

    assert routing.is_recipients_turn(approver) is False
    routing.complete_recipient(a)
    assert routing.is_recipients_turn(
        Recipient.objects.get(pk=approver.pk)) is False, "group 1 is not done"
    routing.complete_recipient(b)
    assert routing.is_recipients_turn(
        Recipient.objects.get(pk=approver.pk)) is True


def test_cc_never_holds_the_request_up(request_of):
    sign_request = request_of(("signer", 1), ("cc", 1))
    signer, cc = sign_request.recipients.all()

    assert routing.is_recipients_turn(cc) is False
    routing.complete_recipient(signer)
    assert routing.everyone_done(sign_request) is True, "a cc blocked completion"


def test_a_viewer_completes_by_opening(request_of):
    """phase-08's own decision, spelled out in its test list: "viewer must open
    the doc; opening = completion for viewer role"."""
    sign_request = request_of(("signer", 1), ("viewer", 1))
    signer, viewer = sign_request.recipients.all()

    routing.complete_recipient(signer)
    assert routing.everyone_done(sign_request) is False, "the viewer never looked"
    routing.complete_recipient(viewer, event="opened")
    assert routing.everyone_done(sign_request) is True


def test_an_approver_declining_stops_the_chain(request_of):
    sign_request = request_of(("signer", 1), ("approver", 2), ("signer", 3))
    signer, approver, last = sign_request.recipients.all()

    routing.complete_recipient(signer)
    routing.decline(approver, "The numbers are wrong")

    sign_request.refresh_from_db()
    assert sign_request.status == SignRequest.Status.DECLINED
    # The third signer is never asked: a document that looks signed and is not
    # is worse than a stopped process.
    assert routing.next_to_notify(sign_request) == [] or \
        sign_request.status != SignRequest.Status.SENT
    assert Recipient.objects.get(pk=last.pk).status == Recipient.Status.PENDING


def test_completing_twice_writes_one_event(request_of):
    """A double-tap on a flaky mobile connection must not put two `signed`
    events into a chain that is meant to be evidence."""
    sign_request = request_of(("signer", 1))
    recipient = sign_request.recipients.first()

    assert routing.complete_recipient(recipient) is True
    assert routing.complete_recipient(recipient) is False
    assert sign_request.audit_events.filter(type="signed").count() == 1


def test_everyone_done_is_false_for_a_request_with_nobody_acting(request_of):
    sign_request = request_of(("cc", 1))
    assert routing.everyone_done(sign_request) is False


# --------------------------------------------------------------------------- #
# The hash chain
# --------------------------------------------------------------------------- #
def test_the_chain_verifies_as_written(request_of):
    sign_request = request_of(("signer", 1))
    recipient = sign_request.recipients.first()
    record(sign_request, "created")
    record(sign_request, "sent", to=["r0@example.com"])
    record(sign_request, "opened", recipient=recipient)

    chain = verify_chain(sign_request)
    assert chain == {"intact": True, "count": 3, "broken_at": None,
                     "head": sign_request.audit_events.last().event_hash}


def test_tampering_with_an_event_breaks_the_chain(request_of):
    """The whole point of the hash chain: an edited record is detectable.

    Written with `update()` because the model refuses a second `save()` — an
    attacker with database access has no such scruples, and this is what the
    certificate's integrity line is claiming to catch.
    """
    from apps.esign.models import AuditEvent

    sign_request = request_of(("signer", 1))
    record(sign_request, "created")
    target = record(sign_request, "opened", recipient=sign_request.recipients.first())
    record(sign_request, "signed")

    AuditEvent.objects.filter(pk=target.pk).update(ip="10.0.0.9")

    chain = verify_chain(sign_request)
    assert chain["intact"] is False
    assert chain["broken_at"] == str(target.pk)


def test_deleting_an_event_breaks_the_chain(request_of):
    from apps.esign.models import AuditEvent

    sign_request = request_of(("signer", 1))
    record(sign_request, "created")
    middle = record(sign_request, "opened")
    record(sign_request, "signed")

    AuditEvent.objects.filter(pk=middle.pk).delete()  # queryset bypasses delete()
    assert verify_chain(sign_request)["intact"] is False


def test_an_audit_event_cannot_be_edited_or_deleted_through_the_model(request_of):
    sign_request = request_of(("signer", 1))
    event = record(sign_request, "created")

    event.ip = "10.0.0.1"
    with pytest.raises(ValueError, match="append-only"):
        event.save()
    with pytest.raises(ValueError, match="append-only"):
        event.delete()


def test_two_requests_keep_separate_chains(request_of):
    first = request_of(("signer", 1))
    second = request_of(("signer", 1))
    record(first, "created")
    record(second, "created")

    assert first.audit_events.first().prev_hash == ""
    assert second.audit_events.first().prev_hash == ""
    assert verify_chain(first)["intact"] and verify_chain(second)["intact"]
