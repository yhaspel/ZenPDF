"""The branches of `esign.tasks` that a clean two-signer loop never takes.

`test_sign_api.py` and `test_finalize_resume.py` prove the happy path and the
kill-and-resume path. What is left is the set of *decisions* the tasks make
when something is not as expected: a checkbox that was ticked or not, a field
placed off the end of the document, a signature field with no image, the §11
lock being held by somebody else, a request that is no longer `sent`, a
version detached by an account closure, and the reminder sweep's reasons for
leaving somebody alone today. Each one is a line the owner or the signer would
notice the wrong side of — a tick that never printed, a reminder that arrived
twice, a finalize that gave up for ever on a busy document.
"""
import base64
from unittest import mock

import fitz
import pytest
from django.core import mail
from django.utils import timezone

from apps.esign import tasks
from apps.esign.models import Recipient, SignRequest
from apps.pdf_engine.exceptions import EngineError
from apps.pdf_engine.storage import get_storage

pytestmark = pytest.mark.django_db


def _ink() -> bytes:
    doc = fitz.open()
    page = doc.new_page(width=300, height=120)
    page.draw_line((40, 80), (260, 50), width=3)
    data = page.get_pixmap(alpha=True).tobytes("png")
    doc.close()
    return data


def _data_url(data: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(data).decode()


@pytest.fixture(autouse=True)
def _verified(user):
    user.email_verified = True
    user.save(update_fields=["email_verified"])
    return user


@pytest.fixture
def sent(api, uploaded_doc):
    """One signer holding a signature, a checkbox and a text field — sent."""
    created = api.post("/api/sign-requests/",
                       {"document": uploaded_doc["id"], "title": "Offer"},
                       format="json")
    assert created.status_code == 201, created.content
    request_id = created.json()["id"]
    people = api.patch(f"/api/sign-requests/{request_id}/",
                       {"recipients": [{"email": "signer@example.com",
                                        "name": "Sam", "role": "signer",
                                        "order": 1}]},
                       format="json").json()["recipients"]
    base = {"recipient_id": people[0]["id"], "page": 0, "x": 0.1, "w": 0.3,
            "h": 0.08, "required": True}
    resp = api.patch(f"/api/sign-requests/{request_id}/", {"fields": [
        {**base, "y": 0.7, "type": "signature", "label": "Sign"},
        {**base, "y": 0.5, "w": 0.05, "h": 0.05, "type": "checkbox",
         "label": "Agree", "required": False},
        {**base, "y": 0.3, "type": "text", "label": "Name", "required": False},
    ]}, format="json")
    assert resp.status_code == 200, resp.content
    assert api.post(f"/api/sign-requests/{request_id}/send/",
                    format="json").status_code == 200
    mail.outbox.clear()
    return SignRequest.objects.get(id=request_id)


def _fill(sign_request, type_, **values):
    field = sign_request.fields.get(type=type_)
    for key, value in values.items():
        setattr(field, key, value)
    field.filled_at = timezone.now()
    field.save()
    return field


def _stage_signature(sign_request):
    """A signature image in storage, the way the ceremony leaves it."""
    field = sign_request.fields.get(type="signature")
    key = f"sign/{sign_request.id}/fields/{field.id}.png"
    get_storage().put_bytes(key, _ink(), content_type="image/png")
    field.image_key = key
    field.save(update_fields=["image_key"])
    return field


def _page_text(data: bytes, page: int = 0) -> str:
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        return doc[page].get_text()
    finally:
        doc.close()


def _source(sign_request) -> bytes:
    return get_storage().get_bytes(sign_request.source_version.storage_key)


# --------------------------------------------------------------------------- #
# Burning fields
# --------------------------------------------------------------------------- #
def test_a_ticked_checkbox_prints_an_x_and_an_unticked_one_prints_nothing(sent):
    before = _page_text(_source(sent))
    assert "X" not in before.split(), "the fixture already has a bare X on it"

    _fill(sent, "checkbox", value="false")
    unticked = tasks._burn_fields(_source(sent), sent)
    assert "X" not in _page_text(unticked).split(), "an unticked box printed a tick"

    _fill(sent, "checkbox", value="true")
    ticked = tasks._burn_fields(_source(sent), sent)
    assert "X" in _page_text(ticked).split(), "the tick never reached the page"


def test_a_typed_value_lands_on_the_page(sent):
    _fill(sent, "text", value="Ada Lovelace")
    out = tasks._burn_fields(_source(sent), sent)
    assert "Ada Lovelace" in _page_text(out)


def test_a_field_past_the_end_of_the_document_is_skipped_not_fatal(sent):
    _fill(sent, "text", value="off the end", page=99)
    out = tasks._burn_fields(_source(sent), sent)
    assert out[:5] == b"%PDF-"
    assert "off the end" not in "".join(
        _page_text(out, i) for i in range(sent.source_version.page_count))


def test_a_signature_field_with_no_image_is_left_blank(sent):
    """An unfilled signature box must not make the burn reach into storage,
    and nothing is drawn into it."""
    source = _source(sent)  # outside the patch: any read inside it is the burn's
    storage = get_storage()
    with mock.patch.object(storage, "get_bytes", wraps=storage.get_bytes) as get:
        out = tasks._burn_fields(source, sent)
    get.assert_not_called()
    doc = fitz.open(stream=out, filetype="pdf")
    try:
        assert not doc[0].get_images(), "something was drawn into the empty box"
    finally:
        doc.close()


def test_a_signature_image_is_drawn_into_the_page(sent):
    _stage_signature(sent)
    out = tasks._burn_fields(_source(sent), sent)
    doc = fitz.open(stream=out, filetype="pdf")
    try:
        assert doc[0].get_images(), "the signature was not drawn"
    finally:
        doc.close()


# --------------------------------------------------------------------------- #
# The lock
# --------------------------------------------------------------------------- #
def test_a_busy_lock_schedules_a_retry_rather_than_giving_up(sent):
    """Nothing else ever finalizes an envelope: letting `locked` out would
    leave a fully-signed contract at `sent` with no certificate for ever."""
    from celery.exceptions import Retry

    busy = EngineError("That document is busy with another change.",
                       code="locked")
    task = tasks.finalize_sign_request
    with mock.patch("apps.documents.tasks.doc_lock", side_effect=busy), \
            mock.patch.object(task, "retry",
                              side_effect=Retry("later")) as retry:
        with pytest.raises(Retry):
            task(str(sent.id))
    retry.assert_called_once()
    assert retry.call_args.kwargs["countdown"] == 60
    assert retry.call_args.kwargs["exc"] is busy
    sent.refresh_from_db()
    assert sent.status == SignRequest.Status.SENT


def test_any_other_engine_error_is_raised_not_retried(sent):
    broken = EngineError("the seal failed", code="seal_failed")
    task = tasks.finalize_sign_request
    with mock.patch("apps.documents.tasks.doc_lock", side_effect=broken), \
            mock.patch.object(task, "retry") as retry:
        with pytest.raises(EngineError, match="the seal failed"):
            task(str(sent.id))
    retry.assert_not_called()


# --------------------------------------------------------------------------- #
# Skips
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("status", ["draft", "canceled", "declined", "expired"])
def test_a_request_that_is_not_sent_is_skipped_untouched(sent, status):
    SignRequest.objects.filter(pk=sent.pk).update(status=status)
    with mock.patch("apps.esign.tasks.SEAL.seal") as seal:
        result = tasks.finalize_sign_request(str(sent.id))
    assert result == {"skipped": status}
    seal.assert_not_called()
    sent.refresh_from_db()
    assert sent.status == status
    assert not sent.final_key
    assert mail.outbox == []


def test_a_request_whose_version_was_detached_is_skipped(sent):
    """§10.1 detaches the frozen version when the account closes; there is
    nothing left to seal and saying so beats a 500."""
    SignRequest.objects.filter(pk=sent.pk).update(source_version=None)
    with mock.patch("apps.esign.tasks.SEAL.seal") as seal:
        result = tasks.finalize_sign_request(str(sent.id))
    assert result == {"skipped": "source version is gone"}
    seal.assert_not_called()
    sent.refresh_from_db()
    assert sent.status == SignRequest.Status.SENT


def test_a_request_completed_under_a_slow_seal_is_not_sealed_twice(sent):
    """Belt and braces behind the Redis lock: a lock that expired under a very
    slow seal must not produce two files either. The row is claimed inside the
    transaction, so a completion that landed in the meantime wins."""
    _stage_signature(sent)
    storage = get_storage()
    real_seal = tasks.SEAL.seal

    def _slow_seal(data, **kwargs):
        # Somebody else finished while this seal was running.
        SignRequest.objects.filter(pk=sent.pk).update(
            status=SignRequest.Status.COMPLETED, final_sha256="theirs",
            final_key="sign/theirs/final.pdf")
        return real_seal(data, **kwargs)

    with mock.patch("apps.esign.tasks.SEAL.seal", side_effect=_slow_seal), \
            mock.patch.object(storage, "put_bytes",
                              wraps=storage.put_bytes) as put:
        result = tasks._finalize(str(sent.id))

    assert result == {"already": True, "envelope": sent.envelope_code}
    sent.refresh_from_db()
    assert sent.final_sha256 == "theirs", "the loser overwrote the winner"
    assert sent.final_key == "sign/theirs/final.pdf"
    assert not any(str(c.args[0]).endswith("final.pdf")
                   for c in put.call_args_list), "a second file was written"


# --------------------------------------------------------------------------- #
# Why an append declined
# --------------------------------------------------------------------------- #
def test_an_engine_error_with_copy_is_shown_to_the_owner_verbatim():
    reason = tasks._append_failure_reason(
        EngineError("The document has 2001 pages; the limit is 2000."))
    assert reason == "The document has 2001 pages; the limit is 2000."


def test_an_engine_error_whose_message_is_blank_gets_the_fixed_sentence():
    # Blanked by hand: the constructor never leaves `.message` empty. A real
    # copy-less `EngineError()` carries its class docstring, and a subclass
    # without one its `code`, and today that developer text reaches the owner
    # verbatim. That is a separate defect, deliberately not asserted either way.
    exc = EngineError("x")
    exc.message = ""
    assert tasks._append_failure_reason(exc) == tasks._APPEND_GENERIC_REASON


def test_a_domain_error_speaks_for_itself_and_anything_else_does_not():
    from apps.core.exceptions import QuotaExceeded

    assert tasks._append_failure_reason(
        QuotaExceeded("Empty your trash to free some up.")
    ) == "Empty your trash to free some up."
    assert tasks._append_failure_reason(
        RuntimeError("Traceback (most recent call last)")
    ) == tasks._APPEND_GENERIC_REASON


def test_a_busy_document_is_a_reason_the_owner_can_read(sent):
    """`doc_lock` failing closed under the append is a domain error with copy;
    the owner sees "busy", not the generic sentence, and the append stays
    unmarked so the next resume tries again."""
    SignRequest.objects.filter(pk=sent.pk).update(final_key="sign/x/final.pdf")
    sent.refresh_from_db()
    busy = EngineError("That document is busy with another change. Try again "
                       "in a moment.", code="locked")
    with mock.patch("apps.documents.tasks.doc_lock", side_effect=busy), \
            mock.patch("apps.esign.tasks.get_storage") as storage:
        storage.return_value.get_bytes.return_value = b"%PDF-1.4"
        tasks._append_to_source_document(sent)
    sent.refresh_from_db()
    assert sent.source_appended_at is None
    assert "busy with another change" in sent.source_append_error


# --------------------------------------------------------------------------- #
# The reminder sweep's reasons to stay quiet
# --------------------------------------------------------------------------- #
def _due(sign_request, email="signer@example.com", days=4):
    Recipient.objects.filter(sign_request=sign_request, email=email).update(
        last_notified_at=timezone.now() - timezone.timedelta(days=days))


def test_a_cadence_of_zero_means_never_remind(sent):
    _due(sent)
    SignRequest.objects.filter(pk=sent.pk).update(reminder_every_days=0)
    assert tasks.sign_reminders() == {"reminders": 0}
    assert mail.outbox == []


def test_an_expired_request_is_not_reminded_about(sent):
    """Expiry is the sweep after this one; in between, a reminder to sign a
    document that can no longer be signed is just a dead link."""
    _due(sent)
    SignRequest.objects.filter(pk=sent.pk).update(
        expires_at=timezone.now() - timezone.timedelta(minutes=1))
    assert tasks.sign_reminders() == {"reminders": 0}
    assert mail.outbox == []


def test_a_request_with_nobody_left_to_act_is_not_reminded(sent):
    """Everyone has completed but finalize has not run yet — there is no
    current group, and nobody to nudge."""
    _due(sent)
    Recipient.objects.filter(sign_request=sent).update(
        status=Recipient.Status.COMPLETED, completed_at=timezone.now())
    assert tasks.sign_reminders() == {"reminders": 0}
    assert mail.outbox == []


@pytest.mark.parametrize("status", ["pending", "completed", "declined"])
def test_a_recipient_who_was_never_asked_or_has_answered_is_left_alone(sent,
                                                                        status):
    """`pending` has not had the first email yet (suppressed at send), so a
    *reminder* would be the first thing they hear from us; the other two have
    nothing left to do."""
    _due(sent)
    Recipient.objects.filter(sign_request=sent).update(status=status)
    assert tasks.sign_reminders() == {"reminders": 0}
    assert mail.outbox == []


def test_a_cc_is_never_nudged(api, uploaded_doc):
    created = api.post("/api/sign-requests/", {"document": uploaded_doc["id"]},
                       format="json").json()
    people = api.patch(f"/api/sign-requests/{created['id']}/", {"recipients": [
        {"email": "signer@example.com", "role": "signer", "order": 1},
        {"email": "watcher@example.com", "role": "cc", "order": 1},
    ]}, format="json").json()["recipients"]
    api.patch(f"/api/sign-requests/{created['id']}/", {"fields": [
        {"recipient_id": people[0]["id"], "page": 0, "x": 0.1, "y": 0.7,
         "w": 0.3, "h": 0.08, "type": "signature", "required": True}]},
        format="json")
    assert api.post(f"/api/sign-requests/{created['id']}/send/",
                    format="json").status_code == 200
    Recipient.objects.filter(sign_request_id=created["id"]).update(
        status=Recipient.Status.VIEWED,
        last_notified_at=timezone.now() - timezone.timedelta(days=4))
    mail.outbox.clear()

    assert tasks.sign_reminders() == {"reminders": 1}
    assert [m.to for m in mail.outbox] == [["signer@example.com"]]


def test_a_reminder_the_suppression_list_swallows_is_not_recorded(sent):
    from apps.core import mail as core_mail

    _due(sent)
    core_mail.suppress("signer@example.com")
    assert tasks.sign_reminders() == {"reminders": 0}
    assert mail.outbox == []
    assert not sent.audit_events.filter(type="reminder_sent").exists()
    # …and the nudge is not spent either: `last_notified_at` is untouched.
    recipient = Recipient.objects.get(sign_request=sent)
    assert (timezone.now() - recipient.last_notified_at).days >= 4


def test_a_recipient_reminded_within_the_cadence_waits(sent):
    _due(sent, days=2)
    assert tasks.sign_reminders() == {"reminders": 0}
    _due(sent, days=3)
    assert tasks.sign_reminders() == {"reminders": 1}
    assert mail.outbox[0].to == ["signer@example.com"]
    assert sent.audit_events.filter(type="reminder_sent").count() == 1


# --------------------------------------------------------------------------- #
# The models and routing branches the loop skips
# --------------------------------------------------------------------------- #
def test_a_checkbox_counts_as_filled_once_it_has_been_answered_either_way(sent):
    field = sent.fields.get(type="checkbox")
    assert field.is_filled is False
    field.value = "false"
    assert field.is_filled is True, "an unticked box is still an answered box"
    field.value = "maybe"
    assert field.is_filled is False
    field.value = "true"
    assert field.is_filled is True


def test_acting_recipients_leaves_out_the_cc(user):
    sign_request = SignRequest.objects.create(
        owner=user, title="Offer", status=SignRequest.Status.SENT,
        sent_at=timezone.now())
    for role in ("signer", "approver", "viewer", "cc"):
        Recipient.objects.create(sign_request=sign_request,
                                 email=f"{role}@example.com", role=role)
    assert sorted(r.role for r in sign_request.acting_recipients()) == \
        ["approver", "signer", "viewer"]


def test_nobody_is_next_once_everyone_has_acted(sent):
    from apps.esign import routing

    Recipient.objects.filter(sign_request=sent).update(
        status=Recipient.Status.COMPLETED, completed_at=timezone.now())
    assert routing.current_group(sent) is None
    assert routing.next_to_notify(sent) == []


def test_advancing_a_parallel_group_with_people_still_in_it_waits(user):
    """Two in the same group, one done: nobody new to email, not finished —
    the third outcome, and the one that must send no mail at all."""
    from apps.esign import routing

    sign_request = SignRequest.objects.create(
        owner=user, title="Offer", status=SignRequest.Status.SENT,
        sent_at=timezone.now(), sender_email="alice@example.com")
    first = Recipient.objects.create(
        sign_request=sign_request, email="a@example.com", role="signer",
        order=1, last_notified_at=timezone.now())
    Recipient.objects.create(
        sign_request=sign_request, email="b@example.com", role="signer",
        order=1, last_notified_at=timezone.now())
    routing.complete_recipient(first)
    mail.outbox.clear()

    assert routing.advance(sign_request) == "waiting"
    assert mail.outbox == []
    assert not sign_request.audit_events.filter(
        type="sent", metadata__stage="routing").exists()


# --------------------------------------------------------------------------- #
# Emails that did not go
# --------------------------------------------------------------------------- #
def test_an_invitation_the_suppression_list_swallows_is_not_counted_as_sent(
        api, uploaded_doc):
    """`notify_recipients` returns who was *reached*; a suppressed signer is
    left `pending` with no `last_notified_at`, and the audit event says so."""
    from apps.core import mail as core_mail

    core_mail.suppress("quiet@example.com")
    created = api.post("/api/sign-requests/", {"document": uploaded_doc["id"]},
                       format="json").json()
    people = api.patch(f"/api/sign-requests/{created['id']}/", {"recipients": [
        {"email": "quiet@example.com", "role": "signer", "order": 1},
        {"email": "loud@example.com", "role": "signer", "order": 1},
    ]}, format="json").json()["recipients"]
    api.patch(f"/api/sign-requests/{created['id']}/", {"fields": [
        {"recipient_id": p["id"], "page": 0, "x": 0.1, "y": 0.7, "w": 0.3,
         "h": 0.08, "type": "signature", "required": True} for p in people]},
        format="json")
    mail.outbox.clear()
    assert api.post(f"/api/sign-requests/{created['id']}/send/",
                    format="json").status_code == 200

    assert [m.to for m in mail.outbox] == [["loud@example.com"]]
    quiet = Recipient.objects.get(sign_request_id=created["id"],
                                  email="quiet@example.com")
    assert quiet.status == Recipient.Status.PENDING
    assert quiet.last_notified_at is None
    event = SignRequest.objects.get(id=created["id"]).audit_events.get(type="sent")
    assert event.metadata["to"] == ["loud@example.com"]
    assert event.metadata["not_delivered"] == ["quiet@example.com"]


def test_sending_to_nobody_sends_nothing(sent):
    from apps.esign import emails

    mail.outbox.clear()
    assert emails._send("Subject", "Body", []) == 0
    assert emails.notify_recipients(sent, []) == []
    assert mail.outbox == []


# --------------------------------------------------------------------------- #
# The certificate's user-agent block
# --------------------------------------------------------------------------- #
def test_the_certificate_prints_each_consenting_browser(api, anon, sent):
    from apps.esign import certificate

    token = Recipient.objects.get(sign_request=sent).token
    anon.credentials(HTTP_USER_AGENT="Mozilla/5.0 (iPhone) Safari/605.1")
    anon.get(f"/api/public/sign/{token}/")
    anon.post(f"/api/public/sign/{token}/consent/", {"agree": True},
              format="json")

    text = "\n".join(page.get_text() for page in fitz.open(
        stream=certificate.build(sent), filetype="pdf"))
    assert "signer@example.com — Mozilla/5.0 (iPhone) Safari/605.1" in \
        text.replace("\n", " ")


def test_the_certificate_omits_the_browser_block_before_anyone_consents(sent):
    from apps.esign import certificate

    text = "\n".join(page.get_text() for page in fitz.open(
        stream=certificate.build(sent), filetype="pdf"))
    assert "Mozilla" not in text
    assert "signer@example.com —" not in text
