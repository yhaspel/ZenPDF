"""Export and deletion when storage is not cooperating (§10.1).

`test_privacy.py` pins what export and deletion *do*. These pin what they do
when a blob is missing or storage refuses: a subject-access export must still
complete — one unreadable file becomes `"file": null` in the manifest, not a
500 for the whole zip — and account deletion must carry on past a blob it
cannot delete, because the rows are already committed by the time the purge
runs and stopping halfway would leave orphans that nothing can ever find.
"""
import io
import json
import logging
import zipfile
from unittest.mock import patch

import pytest

from apps.pdf_engine.storage import get_storage
from apps.users.privacy import _purge_storage, export_zip

pytestmark = pytest.mark.django_db

SEAL_KEY = "sign/00000000-0000-0000-0000-000000000000/final.pdf"


def _read_export(user) -> tuple[dict, list[str]]:
    path, _name = export_zip(user)
    with open(path, "rb") as fh:
        content = fh.read()
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        return json.loads(archive.read("manifest.json")), archive.namelist()


def _completed_request(api, uploaded_doc, user, *, final_key: str):
    from apps.esign.models import SignRequest

    user.email_verified = True
    user.save(update_fields=["email_verified"])
    request = api.post("/api/sign-requests/", {"document": uploaded_doc["id"]},
                       format="json").json()
    SignRequest.objects.filter(id=request["id"]).update(
        status="completed", final_key=final_key, title="Lease")
    return request["id"]


# --------------------------------------------------------------------------- #
# Export
# --------------------------------------------------------------------------- #
def test_a_document_whose_blob_is_missing_is_listed_with_file_null(
        api, user, uploaded_doc, caplog):
    from apps.documents.models import Document

    key = Document.objects.get(id=uploaded_doc["id"]).current_version.storage_key
    get_storage().delete(key)

    with caplog.at_level(logging.ERROR, logger="apps.users.privacy"):
        manifest, names = _read_export(user)

    entry = manifest["documents"][0]
    assert entry["title"] == uploaded_doc["title"]
    assert entry["file"] is None
    assert not any(name.startswith("documents/") for name in names)
    assert "manifest.json" in names and "README.txt" in names
    assert f"could not read {key}" in caplog.text


def test_one_missing_blob_does_not_drop_the_other_documents(api, user, fixture_bytes):
    from django.core.files.uploadedfile import SimpleUploadedFile

    from apps.documents.models import Document

    ids = []
    for title in ("keep.pdf", "lost.pdf"):
        resp = api.post("/api/documents/",
                        {"file": SimpleUploadedFile(title, fixture_bytes("text.pdf"),
                                                    content_type="application/pdf")},
                        format="multipart")
        ids.append(resp.json()["id"])
    lost = Document.objects.get(id=ids[1])
    get_storage().delete(lost.current_version.storage_key)

    manifest, names = _read_export(user)
    by_title = {entry["title"]: entry for entry in manifest["documents"]}
    assert by_title["lost"]["file"] is None
    assert by_title["keep"]["file"] in names


def test_a_completed_envelope_whose_seal_is_missing_still_exports(
        api, user, uploaded_doc, caplog):
    _completed_request(api, uploaded_doc, user, final_key=SEAL_KEY)
    assert not get_storage().exists(SEAL_KEY)
    with caplog.at_level(logging.ERROR, logger="apps.users.privacy"):
        manifest, names = _read_export(user)

    envelopes = manifest["signature_requests"]
    assert len(envelopes) == 1
    assert envelopes[0]["status"] == "completed"
    assert envelopes[0]["title"] == "Lease"
    assert not any(name.startswith("signed/") for name in names)
    assert f"export: could not read {SEAL_KEY}" in caplog.text
    # The document itself was readable and is still in the zip.
    assert manifest["documents"][0]["file"] in names


def test_a_completed_envelope_whose_seal_exists_is_in_the_zip(api, user, uploaded_doc):
    get_storage().put_bytes(SEAL_KEY, b"%PDF-1.7 sealed")
    try:
        _completed_request(api, uploaded_doc, user, final_key=SEAL_KEY)
        path, _ = export_zip(user)
        with open(path, "rb") as fh:
            archive = zipfile.ZipFile(io.BytesIO(fh.read()))
        assert archive.read("signed/Lease.pdf") == b"%PDF-1.7 sealed"
    finally:
        get_storage().delete(SEAL_KEY)


# --------------------------------------------------------------------------- #
# Deletion: the post-commit purge carries on past every failure
# --------------------------------------------------------------------------- #
def test_the_purge_continues_past_a_blob_it_cannot_delete(caplog):
    storage = get_storage()
    deleted = []

    def flaky_delete(key):
        if key == "docs/bad":
            raise OSError("locked")
        deleted.append(key)

    with patch.object(storage, "delete", side_effect=flaky_delete), \
            patch.object(storage, "delete_prefix", return_value=0) as prefix, \
            caplog.at_level(logging.ERROR, logger="apps.users.privacy"):
        _purge_storage(["docs/bad", "docs/good"], ["thumbs/x/"], "uid")

    assert deleted == ["docs/good"]
    # The prefix sweep and the asset sweep both still ran.
    assert [c.args[0] for c in prefix.call_args_list] == ["thumbs/x/", "uploads/u/uid/"]
    assert "delete_account: blob docs/bad" in caplog.text


def test_the_purge_continues_past_a_prefix_it_cannot_sweep(caplog):
    storage = get_storage()
    swept = []

    def flaky_prefix(prefix):
        if prefix == "thumbs/bad/":
            raise OSError("down")
        swept.append(prefix)
        return 1

    with patch.object(storage, "delete"), \
            patch.object(storage, "delete_prefix", side_effect=flaky_prefix), \
            patch("apps.core.assets.purge_principal_assets") as assets, \
            caplog.at_level(logging.WARNING, logger="apps.users.privacy"):
        _purge_storage([], ["thumbs/bad/", "thumbs/good/"], "uid")

    assert swept == ["thumbs/good/"]
    assets.assert_called_once_with("u", "uid")
    assert "could not delete thumbs/bad/" in caplog.text


def test_the_purge_survives_the_asset_sweep_raising(caplog):
    storage = get_storage()
    with patch.object(storage, "delete"), \
            patch.object(storage, "delete_prefix"), \
            patch("apps.core.assets.purge_principal_assets",
                  side_effect=RuntimeError("boom")), \
            caplog.at_level(logging.ERROR, logger="apps.users.privacy"):
        _purge_storage([], [], "uid")  # must not raise
    assert "delete_account: assets for uid" in caplog.text


def test_a_storage_failure_during_deletion_does_not_undo_the_deletion(
        api, user, uploaded_doc, django_capture_on_commit_callbacks):
    """The rows are committed before the purge runs, so storage refusing
    cannot roll an account back into existence — and the response is still
    the success the person was promised."""
    from django.contrib.auth import get_user_model

    storage = get_storage()
    with patch.object(storage, "delete", side_effect=OSError("locked")), \
            patch.object(storage, "delete_prefix", side_effect=OSError("down")), \
            django_capture_on_commit_callbacks(execute=True):
        resp = api.delete("/api/users/me/delete/", {"password": "pass12345"},
                          format="json")
    assert resp.status_code == 200, resp.content
    assert resp.json()["deleted"] is True
    assert not get_user_model().objects.filter(pk=user.pk).exists()
