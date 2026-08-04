"""L4 — one `signed` event per signer, even when "Finish" is tapped twice.

`complete_recipient` read the row, decided it was not COMPLETED, wrote the
status and then appended the audit event. That is idempotent against a *serial*
double-tap and not against a concurrent one: two requests both read `sent`,
both write COMPLETED, and both append `signed` — two events, in a chain whose
whole value is that it says what happened once.

The claim is now a conditional UPDATE, and the event is written only by whoever
changed a row.
"""
import pytest
from django.utils import timezone

from apps.esign.models import Recipient, SignRequest
from apps.esign.routing import complete_recipient

pytestmark = pytest.mark.django_db


@pytest.fixture
def recipient(user):
    sign_request = SignRequest.objects.create(
        owner=user, title="Offer", status=SignRequest.Status.SENT,
        sent_at=timezone.now())
    return Recipient.objects.create(
        sign_request=sign_request, email="signer@example.com", name="Sam",
        role=Recipient.Role.SIGNER, order=1)


def test_the_first_call_claims_the_row_and_writes_one_event(recipient):
    assert complete_recipient(recipient) is True

    recipient.refresh_from_db()
    assert recipient.status == Recipient.Status.COMPLETED
    assert recipient.completed_at is not None
    assert recipient.sign_request.audit_events.filter(type="signed").count() == 1


def test_a_second_call_claims_nothing_and_writes_nothing(recipient):
    complete_recipient(recipient)
    first_completed_at = Recipient.objects.get(pk=recipient.pk).completed_at

    assert complete_recipient(recipient) is False

    assert recipient.sign_request.audit_events.filter(type="signed").count() == 1
    # …and the timestamp is not quietly moved either: it is when they signed.
    assert Recipient.objects.get(pk=recipient.pk).completed_at == first_completed_at


def test_a_caller_holding_a_stale_row_still_loses(recipient):
    """The concurrent case, staged: two objects for one row, both believing
    they are looking at a recipient who has not finished.

    Read-then-write passed this — both saw `sent` in memory. The conditional
    UPDATE does not: only one of them changes a row.
    """
    stale = Recipient.objects.get(pk=recipient.pk)
    assert stale.status != Recipient.Status.COMPLETED

    assert complete_recipient(recipient) is True
    assert complete_recipient(stale) is False

    assert recipient.sign_request.audit_events.filter(type="signed").count() == 1


def test_the_in_memory_object_is_left_describing_the_row(recipient):
    """Callers read `completed_at` straight off it — the certificate's
    date-signed fields, for one — so it must not be left stale."""
    complete_recipient(recipient)
    assert recipient.status == Recipient.Status.COMPLETED
    assert recipient.completed_at == Recipient.objects.get(pk=recipient.pk).completed_at
