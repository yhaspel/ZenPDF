"""The beat sweeps when storage says no (§15, §21.4).

Every purge in `apps.core.tasks` has a "could not delete" branch, and each
one makes a different promise about what happens next: `guest_purge` still
deletes the rows (expiry means gone, and a blob nothing points at is a cost,
not a leak); `exports_purge` and `jobs_purge` keep the row, because the row is
the only pointer to a blob that is still there and deleting it would strand
the bytes for ever; `trash_purge` counts a database fault on the row delete as
*failed* rather than *kept*, so a sweep that is quietly failing every night is
visible (a failed blob delete never reaches it: `DocumentDetailView._purge`
swallows that, still refunds the bytes and drops the row, so the document
counts as *purged*);
`account_assets_purge` skips an account whose prefix cannot be listed and
carries on to the next. These tests pin each promise, with the log line that
an operator would grep for.
"""
import logging
from datetime import timedelta
from unittest.mock import patch

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone

from apps.core import limits as L
from apps.core.models import GuestSession
from apps.core.tasks import (
    account_assets_purge,
    exports_purge,
    guest_purge,
    jobs_purge,
    trash_purge,
)
from apps.documents.models import Document
from apps.jobs.models import Job
from apps.pdf_engine.storage import FilesystemStorage, get_storage

pytestmark = pytest.mark.django_db


@pytest.fixture
def sweep_log(caplog):
    """The sweeps log to `zenpdf`, which does not propagate to the root
    (settings.LOGGING), so caplog's root handler never sees it. Attach the
    capture handler to that logger directly for the duration of the test."""
    logger = logging.getLogger("zenpdf")
    logger.addHandler(caplog.handler)
    caplog.set_level(logging.INFO, logger="zenpdf")
    try:
        yield caplog
    finally:
        logger.removeHandler(caplog.handler)


def _export(client, doc_id):
    resp = client.post(f"/api/documents/{doc_id}/operations/",
                       {"type": "convert_to", "params": {"format": "txt"},
                        "base_version_seq": 1}, format="json")
    assert resp.status_code == 202, resp.content
    return Job.objects.get(id=resp.json()["id"])


def _finished(job, **delta):
    Job.objects.filter(pk=job.pk).update(finished_at=timezone.now() - timedelta(**delta))


# --------------------------------------------------------------------------- #
# guest_purge: rows go even when a blob will not
# --------------------------------------------------------------------------- #
def test_guest_purge_deletes_the_rows_even_when_a_blob_refuses(guest, guest_doc, sweep_log):
    storage = get_storage()
    session = GuestSession.objects.get()
    version_key = Document.objects.get(id=guest_doc["id"]).current_version.storage_key
    session.expire_now()

    with patch.object(storage, "delete", side_effect=OSError("locked")), \
            patch.object(storage, "delete_prefix", side_effect=OSError("down")):
        stats = guest_purge()

    assert stats["sessions"] == 1
    assert stats["documents"] == 1
    assert GuestSession.objects.count() == 0
    assert Document.objects.count() == 0
    assert f"guest_purge: could not delete {version_key}" in sweep_log.text
    assert f"prefix sweep failed for document {guest_doc['id']}" in sweep_log.text


def test_guest_purge_logs_an_export_prefix_it_cannot_sweep(guest, guest_doc, sweep_log):
    storage = get_storage()
    job = _export(guest, guest_doc["id"])
    assert job.status == Job.Status.SUCCEEDED, job.error_message
    session = GuestSession.objects.get()
    session.expire_now()
    real = storage.delete_prefix

    def flaky(prefix):
        if prefix.startswith("exports/"):
            raise OSError("down")
        return real(prefix)

    with patch.object(storage, "delete_prefix", side_effect=flaky):
        stats = guest_purge()

    assert stats["sessions"] == 1
    assert Job.objects.count() == 0
    assert f"guest_purge: could not delete exports/{job.id}/" in sweep_log.text


# --------------------------------------------------------------------------- #
# exports_purge / jobs_purge: the row is the only pointer, so it stays
# --------------------------------------------------------------------------- #
def test_exports_purge_keeps_the_job_and_the_charge_when_the_delete_fails(
        api, uploaded_doc, user, sweep_log):
    storage = get_storage()
    job = _export(api, uploaded_doc["id"])
    _finished(job, hours=25)
    user.refresh_from_db()
    charged = user.storage_bytes_used
    key = job.result["export"]["storage_key"]

    with patch.object(storage, "delete_prefix", side_effect=OSError("down")):
        stats = exports_purge()

    assert stats == {"jobs": 0, "blobs": 0, "bytes": 0, "previews": 0}
    assert f"exports_purge: could not delete exports/{job.id}/" in sweep_log.text
    job.refresh_from_db()
    assert job.result["export"]["storage_key"] == key, "the pointer survives"
    assert storage.exists(key)
    user.refresh_from_db()
    assert user.storage_bytes_used == charged, "no refund for bytes still held"


def test_exports_purge_skips_a_job_whose_blob_is_already_gone(api, uploaded_doc, user):
    job = _export(api, uploaded_doc["id"])
    _finished(job, hours=25)
    get_storage().delete(job.result["export"]["storage_key"])
    user.refresh_from_db()
    charged = user.storage_bytes_used

    stats = exports_purge()

    assert stats["jobs"] == 0
    user.refresh_from_db()
    assert user.storage_bytes_used == charged, "nothing freed, nothing refunded"


def test_jobs_purge_keeps_a_row_whose_export_it_could_not_delete(api, uploaded_doc, sweep_log):
    storage = get_storage()
    job = _export(api, uploaded_doc["id"])
    _finished(job, days=400)

    with patch.object(storage, "delete_prefix", side_effect=OSError("down")):
        stats = jobs_purge()

    assert stats == {"jobs": 0, "blobs": 0, "kept": 1}
    assert Job.objects.filter(pk=job.pk).exists()
    assert f"jobs_purge: could not delete exports/{job.id}/" in sweep_log.text


def test_jobs_purge_refunds_only_what_it_actually_freed(api, uploaded_doc, user):
    job = _export(api, uploaded_doc["id"])
    _finished(job, days=400)
    # Already swept by something else; the row still names the key.
    get_storage().delete(job.result["export"]["storage_key"])
    user.refresh_from_db()
    charged = user.storage_bytes_used

    stats = jobs_purge()

    assert stats["jobs"] == 1
    assert stats["blobs"] == 0
    assert not Job.objects.filter(pk=job.pk).exists()
    user.refresh_from_db()
    assert user.storage_bytes_used == charged


# --------------------------------------------------------------------------- #
# trash_purge: kept vs failed
# --------------------------------------------------------------------------- #
def _trash_and_age(api, doc_id, settings):
    api.delete(f"/api/documents/{doc_id}/")
    Document.objects.filter(id=doc_id).update(
        trashed_at=timezone.now() - timedelta(days=settings.TRASH_RETENTION_DAYS + 1))


def test_trash_purge_keeps_a_document_under_a_signature_request(
        api, uploaded_doc, user, settings, sweep_log):
    user.email_verified = True
    user.save(update_fields=["email_verified"])
    resp = api.post("/api/sign-requests/", {"document": uploaded_doc["id"]}, format="json")
    assert resp.status_code == 201, resp.content
    _trash_and_age(api, uploaded_doc["id"], settings)

    stats = trash_purge()

    assert stats == {"purged": 0, "kept": 1, "failed": 0}
    assert Document.objects.filter(id=uploaded_doc["id"]).exists()
    assert f"trash_purge: kept {uploaded_doc['id']} (still referenced)" in sweep_log.text


def test_trash_purge_counts_a_row_delete_fault_as_failed_not_kept(
        api, uploaded_doc, settings, sweep_log):
    """`_purge` swallows a single blob delete failing; a database fault on the
    row delete is what reaches the sweep. It must be reported as a failure."""
    _trash_and_age(api, uploaded_doc["id"], settings)

    with patch.object(Document, "delete", side_effect=RuntimeError("db gone")):
        stats = trash_purge()

    assert stats == {"purged": 0, "kept": 0, "failed": 1}
    assert Document.objects.filter(id=uploaded_doc["id"]).exists()
    assert f"trash_purge: failed on {uploaded_doc['id']}" in sweep_log.text


def test_trash_purge_carries_on_past_one_failure(api, fixture_bytes, settings):
    ids = []
    for _ in range(2):
        upload = SimpleUploadedFile("text.pdf", fixture_bytes("text.pdf"),
                                    content_type="application/pdf")
        ids.append(api.post("/api/documents/", {"file": upload},
                            format="multipart").json()["id"])
    for doc_id in ids:
        _trash_and_age(api, doc_id, settings)
    real = Document.delete

    def flaky(self, *args, **kwargs):
        if str(self.id) == ids[0]:
            raise RuntimeError("db gone")
        return real(self, *args, **kwargs)

    with patch.object(Document, "delete", flaky):
        stats = trash_purge()

    assert stats == {"purged": 1, "kept": 0, "failed": 1}
    assert Document.objects.filter(id=ids[0]).exists()
    assert not Document.objects.filter(id=ids[1]).exists()


# --------------------------------------------------------------------------- #
# account_assets_purge: listing and deleting
# --------------------------------------------------------------------------- #
def _stale_asset(user, days: float = 10):
    import os

    import fitz

    from apps.core.assets import store_image

    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 4, 4))
    pix.set_rect(pix.irect, (0, 128, 0))
    ref = store_image(user, pix.tobytes("png"))["ref"]
    storage = get_storage()
    assert isinstance(storage, FilesystemStorage)  # the hermetic suite's backend
    key = f"uploads/u/{user.pk}/{ref}.png"
    when = (timezone.now() - timedelta(days=days)).timestamp()
    os.utime(storage._path(key), (when, when))  # noqa: SLF001 - filesystem backend
    return key


def test_account_assets_purge_skips_an_account_it_cannot_list(user, other_user, sweep_log):
    storage = get_storage()
    mine = _stale_asset(user)
    theirs = _stale_asset(other_user)
    real = storage.list_prefix_detailed

    def flaky(prefix):
        if str(user.pk) in prefix:
            raise OSError("listing failed")
        return real(prefix)

    with patch.object(storage, "list_prefix_detailed", side_effect=flaky):
        stats = account_assets_purge()

    assert f"account_assets_purge: could not list uploads/u/{user.pk}/" in sweep_log.text
    assert storage.exists(mine), "the unlistable account is left for tomorrow"
    assert not storage.exists(theirs), "the other account was still swept"
    assert stats["users"] == 1


def test_account_assets_purge_skips_a_blob_it_cannot_delete_and_refunds_the_rest(
        user, sweep_log):
    storage = get_storage()
    first = _stale_asset(user)
    second = _stale_asset(user)
    user.refresh_from_db()
    charged = user.storage_bytes_used
    size_second = storage.head(second)["size"]
    real = storage.delete

    def flaky(key):
        if key == first:
            raise OSError("locked")
        return real(key)

    with patch.object(storage, "delete", side_effect=flaky):
        stats = account_assets_purge()

    assert f"account_assets_purge: could not delete {first}" in sweep_log.text
    assert storage.exists(first)
    assert not storage.exists(second)
    assert stats["blobs"] == 1
    user.refresh_from_db()
    assert user.storage_bytes_used == charged - size_second
    assert L.storage_used_fresh(user) == charged - size_second


def test_account_assets_purge_refunds_nothing_when_every_delete_fails(user):
    storage = get_storage()
    _stale_asset(user)
    user.refresh_from_db()
    charged = user.storage_bytes_used

    with patch.object(storage, "delete", side_effect=OSError("locked")):
        stats = account_assets_purge()

    assert stats["blobs"] == 0
    assert stats["users"] == 0
    user.refresh_from_db()
    assert user.storage_bytes_used == charged
