"""The export TTL (§15, §13; phase-06).

Exports are the one namespace nothing else sweeps: `convert_to` writes
`exports/{job_id}/{filename}` and no row is ever deleted for it. The UI tells
the user on two screens that exports are "kept for 24 hours, then deleted", so
this is the task that makes that sentence true.
"""
from datetime import timedelta

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone

from apps.core import limits as L
from apps.core.tasks import exports_purge
from apps.jobs.models import Job
from apps.pdf_engine.storage import get_storage

pytestmark = pytest.mark.django_db


def _export(client, doc_id, fmt="txt"):
    resp = client.post(f"/api/documents/{doc_id}/operations/",
                       {"type": "convert_to", "params": {"format": fmt},
                        "base_version_seq": 1}, format="json")
    assert resp.status_code == 202, resp.content
    return Job.objects.get(id=resp.json()["id"])


def _age(job, hours):
    Job.objects.filter(pk=job.pk).update(
        finished_at=timezone.now() - timedelta(hours=hours)
    )


def test_a_fresh_export_is_left_alone(api, uploaded_doc):
    job = _export(api, uploaded_doc["id"])
    key = job.result["export"]["storage_key"]

    assert exports_purge()["jobs"] == 0
    assert get_storage().exists(key)
    assert api.get(f"/api/jobs/{job.id}/download/").status_code == 200


def test_an_export_past_the_ttl_is_deleted(api, uploaded_doc):
    job = _export(api, uploaded_doc["id"])
    key = job.result["export"]["storage_key"]
    _age(job, 25)

    stats = exports_purge()
    assert stats["jobs"] == 1
    assert stats["blobs"] >= 1
    assert not get_storage().exists(key)


def test_the_job_stops_offering_a_download_it_no_longer_has(api, uploaded_doc):
    """A 404 from a link that worked yesterday is the design; a 500 from a
    missing blob is not, and neither is a button that lies."""
    job = _export(api, uploaded_doc["id"])
    _age(job, 25)
    exports_purge()

    job.refresh_from_db()
    assert "export" not in (job.result or {})
    assert api.get(f"/api/jobs/{job.id}/download/").status_code == 404


def test_the_quota_is_given_back(api, uploaded_doc, user):
    """`_save_export` charges the artefact against the principal's storage, so
    a sweep that forgot to refund it would leave a user permanently paying for
    files that no longer exist."""
    job = _export(api, uploaded_doc["id"], fmt="images")
    size = job.result["export"]["size_bytes"]
    assert size > 0

    # `bump_storage` is an UPDATE, so the counter has to be re-read rather than
    # trusted from the instance the test is holding.
    user.refresh_from_db()
    charged = L.storage_used(user)

    _age(job, 25)
    exports_purge()
    user.refresh_from_db()
    assert L.storage_used(user) == charged - size


def test_another_principals_export_is_swept_too(guest, other_guest, fixture_bytes):
    """The sweep is time-based, not principal-based — a guest whose session is
    still alive must not keep an export past its TTL either."""
    upload = SimpleUploadedFile("a.pdf", fixture_bytes("text.pdf"),
                                content_type="application/pdf")
    doc = guest.post("/api/documents/", {"file": upload}, format="multipart").json()
    job = _export(guest, doc["id"])
    key = job.result["export"]["storage_key"]

    _age(job, 30)
    exports_purge()
    assert not get_storage().exists(key)


def test_a_job_with_no_export_is_ignored(api, uploaded_doc):
    resp = api.post(f"/api/documents/{uploaded_doc['id']}/operations/",
                    {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90},
                     "base_version_seq": 1}, format="json")
    job = Job.objects.get(id=resp.json()["id"])
    _age(job, 48)
    assert exports_purge()["jobs"] == 0
    job.refresh_from_db()
    assert job.result and "version_id" in job.result


def test_the_beat_schedule_actually_runs_it():
    """A task nothing schedules is a task that never runs — and §15 names this
    one in the beat list."""
    from django.conf import settings

    tasks = {entry["task"] for entry in settings.CELERY_BEAT_SCHEDULE.values()}
    assert "apps.core.tasks.exports_purge" in tasks


def test_a_guest_session_takes_its_exports_with_it(guest, fixture_bytes):
    """`exports_purge` sweeps by age over Job rows — and a guest's job rows
    cascade away with the session, so by the time it runs there is nothing left
    pointing at the blob. The session sweep has to take them first, or "files
    auto-deleted within 24 hours" is false for exactly the artefact the tool
    page hands the user (§21.4)."""
    from apps.core.models import GuestSession
    from apps.core.tasks import guest_purge

    upload = SimpleUploadedFile("a.pdf", fixture_bytes("text.pdf"),
                                content_type="application/pdf")
    doc = guest.post("/api/documents/", {"file": upload}, format="multipart").json()
    job = _export(guest, doc["id"])
    key = job.result["export"]["storage_key"]
    assert get_storage().exists(key)

    session = GuestSession.objects.get()
    GuestSession.objects.filter(pk=session.pk).update(
        expires_at=timezone.now() - timedelta(hours=1)
    )
    guest_purge()

    assert not get_storage().exists(key), "the guest's export outlived its session"


def test_a_conversion_source_is_freed_once_it_has_been_converted(api):
    """The parked file has done its job either way; leaving it behind charges
    the principal for ever, and nothing sweeps an account's prefix."""
    import fitz

    from apps.core import limits as L

    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 60, 40))
    pix.set_rect(pix.irect, (200, 30, 30))
    upload = SimpleUploadedFile("photo.png", pix.tobytes("png"),
                                content_type="image/png")
    asset = api.post("/api/uploads/source/", {"file": upload},
                     format="multipart").json()

    resp = api.post("/api/operations/",
                    {"type": "convert_from",
                     "params": {"upload_ref": asset["ref"], "filename": "photo.png"}},
                    format="json")
    assert resp.status_code == 202
    assert api.get(f"/api/jobs/{resp.json()['id']}/").json()["status"] == "succeeded"

    from django.contrib.auth import get_user_model

    from apps.core.assets import principal_prefix

    user = get_user_model().objects.get(email="alice@example.com")
    leftovers = [k for k in get_storage().list_prefix(principal_prefix(user))
                 if asset["ref"] in k]
    assert leftovers == [], f"the parked source was not freed: {leftovers}"
    assert L.storage_used(user) >= 0
