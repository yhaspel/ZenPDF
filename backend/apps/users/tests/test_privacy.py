"""Account deletion and export (phase-10 §10.1).

The interesting assertions are not "the row is gone" — they are about the two
things that must *not* happen: a signed contract disappearing because the
sender closed their account, and an account being deleted by whoever is sitting
at an unlocked laptop.
"""
import io
import json
import zipfile

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

pytestmark = pytest.mark.django_db


def _sent_request(api, uploaded_doc, user, email="signer@example.com"):
    from apps.esign.models import Recipient

    user.email_verified = True
    user.save(update_fields=["email_verified"])
    request = api.post("/api/sign-requests/", {"document": uploaded_doc["id"]},
                       format="json").json()
    api.patch(f"/api/sign-requests/{request['id']}/",
              {"recipients": [{"email": email, "role": "signer", "order": 1}]},
              format="json")
    recipient = Recipient.objects.get(sign_request_id=request["id"])
    api.patch(
        f"/api/sign-requests/{request['id']}/",
        {"fields": [{"recipient_id": str(recipient.id), "page": 0, "x": 0.1,
                     "y": 0.1, "w": 0.2, "h": 0.05, "type": "signature",
                     "required": True}]},
        format="json",
    )
    api.post(f"/api/sign-requests/{request['id']}/send/", format="json")
    return request["id"], recipient


# --------------------------------------------------------------------------- #
# Export
# --------------------------------------------------------------------------- #
def test_export_is_a_zip_of_the_documents_and_a_manifest(api, uploaded_doc):
    resp = api.get("/api/users/me/export/")
    assert resp.status_code == 200
    assert resp["Content-Type"] == "application/zip"
    assert "attachment" in resp["Content-Disposition"]

    # Streamed from a temp file that is unlinked as it goes, so the bytes come
    # from `streaming_content` rather than `.content`.
    content = b"".join(resp.streaming_content)
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        names = archive.namelist()
        manifest = json.loads(archive.read("manifest.json"))
        assert any(name.startswith("documents/") for name in names), names
        assert "README.txt" in names
    assert manifest["documents"][0]["title"] == uploaded_doc["title"]
    assert manifest["account"]["email"]
    # The file in the zip is the real PDF, not a placeholder.
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        pdf = archive.read(manifest["documents"][0]["file"])
    assert pdf.startswith(b"%PDF-")


def test_export_needs_an_account(anon, guest):
    assert anon.get("/api/users/me/export/").status_code in (401, 403)
    assert guest.get("/api/users/me/export/").status_code == 403


def test_two_documents_with_the_same_title_are_two_files(api, fixture_bytes):
    from django.core.files.uploadedfile import SimpleUploadedFile

    for _ in range(2):
        api.post("/api/documents/",
                 {"file": SimpleUploadedFile("same.pdf", fixture_bytes("text.pdf"),
                                             content_type="application/pdf")},
                 format="multipart")
    resp = api.get("/api/users/me/export/")
    content = b"".join(resp.streaming_content)
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        documents = [n for n in archive.namelist() if n.startswith("documents/")]
    assert len(documents) == 2, documents


# --------------------------------------------------------------------------- #
# Deletion
# --------------------------------------------------------------------------- #
def test_deleting_an_account_needs_the_password(api, user):
    """The one irreversible action in the product. A borrowed laptop must not
    be enough."""
    from django.contrib.auth import get_user_model

    resp = api.delete("/api/users/me/delete/", {"password": "wrong"},
                      format="json")
    assert resp.status_code == 400
    assert get_user_model().objects.filter(pk=user.pk).exists()


def test_deleting_an_account_erases_documents_and_blobs(
        api, user, uploaded_doc, django_capture_on_commit_callbacks):
    from django.contrib.auth import get_user_model

    from apps.documents.models import Document
    from apps.pdf_engine.storage import get_storage

    version_key = Document.objects.get(id=uploaded_doc["id"]).current_version.storage_key
    # Blobs are deleted **after** the transaction commits — storage is not
    # transactional, and deleting first means a later failure rolls the rows
    # back and leaves an intact account whose files are gone.
    with django_capture_on_commit_callbacks(execute=True):
        resp = api.delete("/api/users/me/delete/", {"password": "pass12345"},
                          format="json")
    assert resp.status_code == 200, resp.content
    assert resp.json()["deleted"] is True
    assert not get_user_model().objects.filter(pk=user.pk).exists()
    assert not Document.objects.filter(id=uploaded_doc["id"]).exists()
    # The blob is gone from storage, not merely unreferenced.
    with pytest.raises(Exception, match=r".*"):  # noqa: B017 - backend-specific
        get_storage().get_bytes(version_key)


def test_a_signed_envelope_outlives_the_account_that_sent_it(api, user,
                                                             uploaded_doc, anon):
    """The counterparty signed a contract. Closing the sender's account must
    not delete their evidence of it — and the record must still name who sent
    it, or it is not a record."""
    from apps.esign.models import SignRequest

    request_id, recipient = _sent_request(api, uploaded_doc, user)
    # A completed envelope has a sealed artifact — that is what makes it
    # evidence, and what the retention rule keys on.
    SignRequest.objects.filter(id=request_id).update(
        status="completed", final_key=f"sign/{request_id}/final.pdf")

    api.delete("/api/users/me/delete/", {"password": "pass12345"}, format="json")

    envelope = SignRequest.objects.get(id=request_id)
    assert envelope.owner_id is None
    assert envelope.document_id is None
    # The snapshot taken at send is what keeps the record printable.
    assert envelope.sender_email == "alice@example.com"
    assert envelope.audit_events.exists()
    assert envelope.recipients.filter(email="signer@example.com").exists()


def test_a_sent_but_unsigned_request_is_canceled_and_then_deleted(
        api, user, uploaded_doc):
    """Cancelled so it stops mailing strangers, and then removed: nobody
    signed it, so keeping it would retain the sender's address, the
    recipients' addresses and both sides' IPs to prove nothing."""
    from apps.esign.models import SignRequest

    request_id, _ = _sent_request(api, uploaded_doc, user)
    resp = api.delete("/api/users/me/delete/", {"password": "pass12345"},
                      format="json")
    assert resp.json()["sign_requests_canceled"] == 1
    assert resp.json()["sign_requests_retained"] == 0
    assert not SignRequest.objects.filter(id=request_id).exists()


def test_the_audit_chain_is_not_rewritten_by_deletion(api, user, uploaded_doc):
    """Editing one row would break every hash after it and destroy the thing
    being kept."""
    from apps.esign.models import SignRequest, verify_chain

    request_id, _ = _sent_request(api, uploaded_doc, user)
    SignRequest.objects.filter(id=request_id).update(
        status="completed", final_key=f"sign/{request_id}/final.pdf")
    api.delete("/api/users/me/delete/", {"password": "pass12345"}, format="json")

    report = verify_chain(SignRequest.objects.get(id=request_id))
    assert report["intact"], report


def test_a_certificate_still_prints_after_the_sender_is_gone(api, user,
                                                             uploaded_doc):
    from apps.esign import certificate
    from apps.esign.models import SignRequest

    request_id, _ = _sent_request(api, uploaded_doc, user)
    SignRequest.objects.filter(id=request_id).update(
        status="completed", final_key=f"sign/{request_id}/final.pdf")
    api.delete("/api/users/me/delete/", {"password": "pass12345"}, format="json")

    pdf = certificate.build(SignRequest.objects.get(id=request_id))
    assert pdf.startswith(b"%PDF-")


def test_deletion_refuses_rather_than_half_finishing_a_huge_account(api, user,
                                                                    monkeypatch):
    from apps.users import privacy

    monkeypatch.setattr(privacy, "MAX_INLINE_DELETE_DOCUMENTS", -1)
    resp = api.delete("/api/users/me/delete/", {"password": "pass12345"},
                      format="json")
    assert resp.status_code == 400
    assert "by hand" in resp.json()["error"]["message"]


def test_a_never_sent_draft_goes_with_the_account(api, user, uploaded_doc):
    """A draft reached nobody, so there is nothing in it to be evidence of —
    only a title and the addresses somebody typed."""
    from apps.esign.models import SignRequest

    draft = api.post("/api/sign-requests/", {"document": uploaded_doc["id"]},
                     format="json").json()
    api.patch(f"/api/sign-requests/{draft['id']}/",
              {"recipients": [{"email": "counterparty@example.com",
                               "role": "signer", "order": 1}]}, format="json")

    resp = api.delete("/api/users/me/delete/", {"password": "pass12345"},
                      format="json")
    assert resp.status_code == 200
    assert not SignRequest.objects.filter(id=draft["id"]).exists()
    assert resp.json()["sign_requests_retained"] == 0


def test_deletion_takes_the_uploads_and_exports_with_it(
        api, user, uploaded_doc, django_capture_on_commit_callbacks):
    """`uploads/u/…` and `exports/{job}/…` are separate namespaces, and once
    the Job rows cascade away nothing can find the exports again."""
    import base64

    from apps.pdf_engine.storage import get_storage

    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmM"
        "IQAAAABJRU5ErkJggg==")
    asset = api.post("/api/uploads/image/",
                     {"file": SimpleUploadedFile("stamp.png", png,
                                                 content_type="image/png")},
                     format="multipart")
    assert asset.status_code in (200, 201), asset.content
    key = f"uploads/u/{user.pk}/{asset.json()['ref']}.png"
    assert get_storage().get_bytes(key)

    with django_capture_on_commit_callbacks(execute=True):
        api.delete("/api/users/me/delete/", {"password": "pass12345"},
                   format="json")

    with pytest.raises(Exception, match=r".*"):  # noqa: B017 - backend-specific
        get_storage().get_bytes(key)


def test_an_unsigned_envelope_does_not_outlive_the_account(api, user,
                                                           uploaded_doc):
    """The one the copy is careful about: sent, opened, consented — and never
    finished. There is no signature in it, so there is nothing to be evidence
    of, and retaining it would keep both sides' addresses and IP addresses."""
    from apps.esign.models import AuditEvent, SignRequest

    request_id, recipient = _sent_request(api, uploaded_doc, user)
    assert AuditEvent.objects.filter(sign_request_id=request_id).exists()

    api.delete("/api/users/me/delete/", {"password": "pass12345"},
               format="json")
    assert not SignRequest.objects.filter(id=request_id).exists()
    assert not AuditEvent.objects.filter(sign_request_id=request_id).exists()


def test_the_export_cannot_contain_a_path(api, user, fixture_bytes):
    """Titles are free text. `../../etc/cron.d/zen` must not become a path in
    the zip a subject-access request produces — CPython's extractall
    sanitises, and plenty of other extractors do not."""
    from django.core.files.uploadedfile import SimpleUploadedFile

    for title in ("../../../../tmp/pwned", "/etc/cron.d/zen"):
        api.post("/api/documents/",
                 {"file": SimpleUploadedFile("x.pdf", fixture_bytes("text.pdf"),
                                             content_type="application/pdf"),
                  "title": title},
                 format="multipart")

    resp = api.get("/api/users/me/export/")
    content = b"".join(resp.streaming_content)
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        names = archive.namelist()

    for name in names:
        assert ".." not in name, name
        assert not name.startswith("/"), name
        assert name.count("/") <= 1, name


def test_deleting_a_user_from_admin_does_not_500(api, user, uploaded_doc,
                                                 django_capture_on_commit_callbacks):
    """`SignRequest.source_version` is PROTECT and fires even inside the same
    cascade, so a plain `user.delete()` raises for anybody who ever sent an
    envelope. Admin goes through the same path the account holder does."""
    from django.contrib.admin.sites import AdminSite
    from django.contrib.auth import get_user_model

    from apps.esign.models import SignRequest
    from apps.users.admin import ZenUserAdmin

    request_id, _ = _sent_request(api, uploaded_doc, user)
    SignRequest.objects.filter(id=request_id).update(
        status="completed", final_key=f"sign/{request_id}/final.pdf")

    model_admin = ZenUserAdmin(get_user_model(), AdminSite())
    with django_capture_on_commit_callbacks(execute=True):
        model_admin.delete_model(None, user)

    assert not get_user_model().objects.filter(pk=user.pk).exists()
    # …and the counterparty's evidence is still there.
    assert SignRequest.objects.filter(id=request_id).exists()
