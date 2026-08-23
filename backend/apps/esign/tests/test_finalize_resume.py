"""M4 — finishing a finalize that was killed after it committed COMPLETED.

`_finalize` commits the status inside an atomic block — it has to, or two
workers seal two different files and `final_sha256` describes a file nobody
has. Everything that makes the completion *usable* happens after that commit:
the certificate, the `seal_applied`/`completed` audit events, the append onto
the source document, and the mail telling everyone it is done.

`finalize` runs on the `heavy` lane with `acks_late`, so a worker killed in
that window is redelivered — and the redelivery used to see COMPLETED and
return `{"already": True}`. The envelope was then permanently broken:
`certificate_key` empty, so the certificate download answered "not ready" for
ever; no completion events, so the audit chain had a hole where its ending
should be; and nobody was ever told the document was finished.

These tests kill it at that exact point and assert the resume finishes the job,
exactly once.
"""
import base64

import pytest
from django.core import mail

from apps.esign.models import Recipient, SignRequest
from apps.esign.tasks import _finalize_tail, finalize_sign_request

pytestmark = pytest.mark.django_db


def _draw_png() -> str:
    import fitz

    doc = fitz.open()
    page = doc.new_page(width=300, height=120)
    page.draw_line((40, 80), (260, 50), width=3)
    data = page.get_pixmap(alpha=True).tobytes("png")
    doc.close()
    return "data:image/png;base64," + base64.b64encode(data).decode()


@pytest.fixture(autouse=True)
def _verified(user):
    user.email_verified = True
    user.save(update_fields=["email_verified"])
    return user


@pytest.fixture
def completed(api, anon, uploaded_doc):
    """One signer, signed through to the end. Returns the SignRequest."""
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
    api.patch(f"/api/sign-requests/{request_id}/",
              {"fields": [{"recipient_id": people[0]["id"], "page": 0,
                           "x": 0.1, "y": 0.7, "w": 0.3, "h": 0.08,
                           "type": "signature", "required": True,
                           "label": "Sign here"}]}, format="json")
    assert api.post(f"/api/sign-requests/{request_id}/send/",
                    format="json").status_code == 200

    token = Recipient.objects.get(sign_request_id=request_id).token
    meta = anon.get(f"/api/public/sign/{token}/").json()
    anon.post(f"/api/public/sign/{token}/consent/", {"agree": True},
              format="json")
    for field in meta["fields"]:
        if field["type"] == "signature":
            anon.post(f"/api/public/sign/{token}/fields/",
                      {"field_id": field["id"], "signature_image": _draw_png()},
                      format="json")
    assert anon.post(f"/api/public/sign/{token}/complete/",
                     format="json").status_code == 200

    sign_request = SignRequest.objects.get(id=request_id)
    assert sign_request.status == SignRequest.Status.COMPLETED
    return sign_request


def _completion_mails(sign_request):
    return [m for m in mail.outbox
            if m.subject.startswith(f"Completed: {sign_request.title}")]


def _one_round_of_mail(sign_request) -> int:
    """`notify_completed` writes to every recipient and to the sender."""
    return sign_request.recipients.count() + 1


def _kill_after_the_commit(sign_request):
    """Rewind to the instant the worker died: status committed, tail unrun."""
    sign_request.audit_events.filter(
        type__in=["seal_applied", "completed"]).delete()
    SignRequest.objects.filter(pk=sign_request.pk).update(
        certificate_key="", completed_notified_at=None, source_appended_at=None)
    sign_request.refresh_from_db()
    mail.outbox.clear()
    return sign_request


# --------------------------------------------------------------------------- #
# The happy path still produces one of everything
# --------------------------------------------------------------------------- #
def test_a_normal_finalize_produces_one_of_each(completed):
    assert completed.certificate_key
    assert completed.completed_notified_at is not None
    assert completed.source_appended_at is not None
    assert completed.audit_events.filter(type="seal_applied").count() == 1
    assert completed.audit_events.filter(type="completed").count() == 1
    assert len(_completion_mails(completed)) == _one_round_of_mail(completed)


def test_running_the_tail_again_changes_nothing(completed):
    before_cert = completed.certificate_key
    before_notified = completed.completed_notified_at
    before_versions = completed.document.versions.count()
    mail.outbox.clear()

    _finalize_tail(completed)
    _finalize_tail(completed)

    completed.refresh_from_db()
    assert completed.certificate_key == before_cert
    assert completed.completed_notified_at == before_notified
    assert completed.audit_events.filter(type="seal_applied").count() == 1
    assert completed.audit_events.filter(type="completed").count() == 1
    assert completed.document.versions.count() == before_versions
    assert _completion_mails(completed) == []


# --------------------------------------------------------------------------- #
# …and a kill in the window is recoverable
# --------------------------------------------------------------------------- #
def test_a_redelivery_finishes_a_tail_that_was_killed(completed, anon):
    """The whole finding, in one test: the envelope used to stay broken."""
    versions_before = completed.document.versions.count()
    sign_request = _kill_after_the_commit(completed)
    assert sign_request.certificate_key == ""

    # This is what Celery does with `acks_late` when the worker dies.
    result = finalize_sign_request(str(sign_request.id))
    assert result["already"] is True

    sign_request.refresh_from_db()
    assert sign_request.certificate_key, "the certificate was never rebuilt"
    assert sign_request.audit_events.filter(type="seal_applied").count() == 1
    assert sign_request.audit_events.filter(type="completed").count() == 1
    assert len(_completion_mails(sign_request)) == _one_round_of_mail(sign_request)
    assert sign_request.completed_notified_at is not None
    # The append is best-effort but it did not happen either, so the resume
    # owes it too.
    assert sign_request.document.versions.count() == versions_before + 1

    # And the thing the recipient actually asked for now answers.
    token = Recipient.objects.get(sign_request_id=sign_request.id).token
    resp = anon.get(f"/api/public/sign/{token}/download/certificate/")
    assert resp.status_code == 200, resp.content
    assert resp["Content-Type"] == "application/pdf"


def test_a_second_redelivery_after_the_resume_is_a_no_op(completed):
    sign_request = _kill_after_the_commit(completed)
    finalize_sign_request(str(sign_request.id))
    mails_after_resume = len(_completion_mails(sign_request))

    finalize_sign_request(str(sign_request.id))

    sign_request.refresh_from_db()
    assert len(_completion_mails(sign_request)) == mails_after_resume
    assert mails_after_resume == _one_round_of_mail(sign_request)
    assert sign_request.audit_events.filter(type="completed").count() == 1


def test_a_resumed_seal_event_says_it_was_resumed(completed):
    """The report that produced the seal died with the run that made it. The
    event is still recorded — a hole in the chain the certificate prints is
    worse — and it says which kind of record it is rather than inventing one."""
    sign_request = _kill_after_the_commit(completed)
    finalize_sign_request(str(sign_request.id))

    event = sign_request.audit_events.get(type="seal_applied")
    assert event.metadata.get("resumed") is True


def test_only_the_missing_half_is_redone(completed):
    """A kill *between* the certificate and the mail must not rebuild the
    certificate — the recipient may already be holding a link to it."""
    before_cert = completed.certificate_key
    SignRequest.objects.filter(pk=completed.pk).update(
        completed_notified_at=None)
    completed.refresh_from_db()
    mail.outbox.clear()

    finalize_sign_request(str(completed.id))

    completed.refresh_from_db()
    assert completed.certificate_key == before_cert
    assert completed.audit_events.filter(type="completed").count() == 1
    assert len(_completion_mails(completed)) == _one_round_of_mail(completed)


# --------------------------------------------------------------------------- #
# An append that declines tells the owner (queue, 2026-08-02)
# --------------------------------------------------------------------------- #
def _over_quota(settings):
    """Shrink the tier until any version write is refused."""
    import copy

    tiers = copy.deepcopy(settings.TIERS)
    tiers["free"]["storage_mb"] = 0
    settings.TIERS = tiers


def test_the_happy_path_sets_no_notice(completed):
    """The regression this pins is the opposite one: a field that is always
    set would show every owner a failure that did not happen."""
    assert completed.source_appended_at is not None
    assert completed.source_append_error is None


def test_an_append_refused_by_quota_is_recorded_on_the_request(completed, settings):
    """The envelope still completes and the certificate is still produced —
    that is the design. What changes is that the owner is told why their
    document did not get the signed copy."""
    versions_before = completed.document.versions.count()
    sign_request = _kill_after_the_commit(completed)
    _over_quota(settings)

    finalize_sign_request(str(sign_request.id))

    sign_request.refresh_from_db()
    assert sign_request.source_appended_at is None
    assert sign_request.source_append_error, "the owner was told nothing"
    assert "storage" in sign_request.source_append_error.lower()
    # Everything else the completion owes still happened.
    assert sign_request.status == SignRequest.Status.COMPLETED
    assert sign_request.certificate_key
    assert sign_request.audit_events.filter(type="completed").count() == 1
    assert sign_request.document.versions.count() == versions_before


def test_a_later_resume_with_room_clears_the_notice(completed, settings):
    """`_finalize_tail` re-runs the append while `source_appended_at` is null.
    An owner who freed some space must stop being told about a failure that no
    longer applies."""
    sign_request = _kill_after_the_commit(completed)
    _over_quota(settings)
    finalize_sign_request(str(sign_request.id))
    sign_request.refresh_from_db()
    assert sign_request.source_append_error

    versions_before = sign_request.document.versions.count()
    settings.TIERS = _generous(settings)
    _finalize_tail(sign_request)

    sign_request.refresh_from_db()
    assert sign_request.source_append_error is None
    assert sign_request.source_appended_at is not None
    assert sign_request.document.versions.count() == versions_before + 1


def _generous(settings):
    import copy

    tiers = copy.deepcopy(settings.TIERS)
    tiers["free"]["storage_mb"] = 2048
    return tiers


def test_the_reason_is_a_sentence_not_a_repr(completed, settings):
    """The notice is rendered verbatim to the owner. A `KeyError` or a stack
    frame in it would be alarming and unactionable, so anything that is not a
    domain error with copy written for a person gets a fixed sentence."""
    from apps.esign import tasks

    sign_request = _kill_after_the_commit(completed)

    def _boom(**kwargs):
        raise KeyError("docs/deadbeef/v3.pdf")

    from apps.documents import tasks as document_tasks

    original = document_tasks._save_new_version
    document_tasks._save_new_version = _boom
    try:
        tasks._append_to_source_document(sign_request)
    finally:
        document_tasks._save_new_version = original

    sign_request.refresh_from_db()
    reason = sign_request.source_append_error
    assert reason == tasks._APPEND_GENERIC_REASON
    assert "KeyError" not in reason
    assert "deadbeef" not in reason


def test_the_owner_sees_the_reason_and_a_recipient_never_does(completed, api,
                                                              anon, settings):
    """It is on the owner's serializer only. The ceremony builds its own dict,
    and a recipient has no business knowing about the sender's storage."""
    sign_request = _kill_after_the_commit(completed)
    _over_quota(settings)
    finalize_sign_request(str(sign_request.id))
    sign_request.refresh_from_db()

    owner_view = api.get(f"/api/sign-requests/{sign_request.id}/")
    assert owner_view.status_code == 200, owner_view.content
    body = owner_view.json()
    assert body["source_append_error"] == sign_request.source_append_error

    token = Recipient.objects.get(sign_request_id=sign_request.id).token
    ceremony = anon.get(f"/api/public/sign/{token}/").json()
    assert "source_append_error" not in ceremony
    assert sign_request.source_append_error not in str(ceremony)


def test_the_owner_cannot_write_the_reason_themselves(completed, api):
    """Read-only by nature and read-only in the serializer: a PATCH that could
    set it would let an owner author a sentence the UI presents as something
    the system observed."""
    resp = api.patch(f"/api/sign-requests/{completed.id}/",
                     {"source_append_error": "Ignore this, it is fine."},
                     format="json")
    assert resp.status_code in (200, 400), resp.content
    completed.refresh_from_db()
    assert completed.source_append_error is None


def test_a_repeated_failure_does_not_rewrite_the_row(completed, settings):
    """Two resumes that fail the same way must not churn the row — the notice
    is a standing condition, not an event log."""
    sign_request = _kill_after_the_commit(completed)
    _over_quota(settings)
    finalize_sign_request(str(sign_request.id))
    sign_request.refresh_from_db()
    first = sign_request.updated_at
    reason = sign_request.source_append_error

    finalize_sign_request(str(sign_request.id))
    sign_request.refresh_from_db()
    assert sign_request.source_append_error == reason
    assert sign_request.updated_at == first
