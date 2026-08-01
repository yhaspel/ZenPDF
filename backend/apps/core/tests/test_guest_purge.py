"""`guest_purge` — hourly hard-delete of expired sessions (§15, §21.4).

Rows *and* blobs. "Nothing orphaned" is the acceptance criterion, and the
subtle half is thumbnails: they are keyed `thumbs/{doc}/{seq}/p{n}@{w}.png`, so
the exact key set is not derivable from the rows.
"""
import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

from apps.core.models import GuestSession, UsageCounter
from apps.core.tasks import guest_purge

pytestmark = pytest.mark.django_db


def _upload(client, fixture_bytes):
    upload = SimpleUploadedFile(
        "text.pdf", fixture_bytes("text.pdf"), content_type="application/pdf"
    )
    resp = client.post("/api/documents/", {"file": upload}, format="multipart")
    assert resp.status_code == 201, resp.content
    return resp.json()


def _keys_for(doc_id):
    from apps.pdf_engine.storage import get_storage

    storage = get_storage()
    return storage.list_prefix(f"docs/{doc_id}/") + storage.list_prefix(f"thumbs/{doc_id}/")


def test_purge_deletes_rows_and_blobs(guest, fixture_bytes):
    doc = _upload(guest, fixture_bytes)
    guest.post(
        f"/api/documents/{doc['id']}/operations/",
        {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90}},
        format="json",
    )
    # Force a thumbnail render so there is a blob the rows cannot name.
    assert guest.get(f"/api/documents/{doc['id']}/pages/0/thumbnail/").status_code == 200

    from apps.documents.models import Document, DocumentVersion
    from apps.jobs.models import Job

    session = GuestSession.objects.get()
    UsageCounter.objects.create(guest_session=session, period="2026-08", heavy_ops=1)
    assert _keys_for(doc["id"]), "expected blobs before purge"

    session.expire_now()
    stats = guest_purge()

    assert stats["sessions"] == 1
    assert stats["documents"] == 1
    assert stats["blobs"] > 0
    # Rows: gone, including the cascade.
    assert Document.objects.count() == 0
    assert DocumentVersion.objects.count() == 0
    assert Job.objects.count() == 0
    assert UsageCounter.objects.count() == 0
    assert GuestSession.objects.count() == 0
    # Blobs: nothing orphaned — version PDFs *and* thumbnails.
    assert _keys_for(doc["id"]) == []


def test_purge_leaves_live_sessions_alone(guest, other_guest, fixture_bytes):
    from apps.documents.models import Document

    live = _upload(guest, fixture_bytes)
    doomed = _upload(other_guest, fixture_bytes)

    from apps.core.models import hash_guest_token

    GuestSession.objects.get(token_hash=hash_guest_token(other_guest.token)).expire_now()
    guest_purge()

    assert Document.objects.filter(id=live["id"]).exists()
    assert not Document.objects.filter(id=doomed["id"]).exists()
    assert guest.get(f"/api/documents/{live['id']}/").status_code == 200
    assert _keys_for(live["id"])


def test_purge_never_cascades_into_claimed_rows(guest, fixture_bytes, user):
    """The failure this design must not produce: losing a logged-in user's files.

    After a claim the session is expired on purpose, so it is a purge candidate
    on the very next run — the rows survive because they no longer point at it.
    """
    from apps.core.claim import claim_session
    from apps.documents.models import Document
    from apps.jobs.models import Job

    doc = _upload(guest, fixture_bytes)
    guest.post(
        f"/api/documents/{doc['id']}/operations/",
        {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90}},
        format="json",
    )
    session = GuestSession.objects.get()
    claim_session(session, user)
    session.refresh_from_db()
    assert session.is_expired  # deliberately a purge candidate

    stats = guest_purge()
    assert stats["sessions"] == 1
    assert stats["documents"] == 0
    assert stats["blobs"] == 0

    claimed = Document.objects.get(id=doc["id"])
    assert claimed.owner_id == user.id
    assert Job.objects.filter(user=user).count() == 1
    assert _keys_for(doc["id"]), "claimed document's blobs must survive"


def test_purge_is_idempotent_and_cheap_when_nothing_expired(guest, fixture_bytes):
    _upload(guest, fixture_bytes)
    assert guest_purge() == {"sessions": 0, "documents": 0, "blobs": 0}
    assert guest_purge() == {"sessions": 0, "documents": 0, "blobs": 0}


def test_purge_never_touches_account_documents(api, uploaded_doc, guest, fixture_bytes):
    from apps.documents.models import Document

    _upload(guest, fixture_bytes)
    GuestSession.objects.get().expire_now()
    guest_purge()
    assert Document.objects.filter(id=uploaded_doc["id"]).exists()
    assert api.get(f"/api/documents/{uploaded_doc['id']}/").status_code == 200


def test_purge_is_scheduled_hourly(settings):
    entry = settings.CELERY_BEAT_SCHEDULE["guest-purge"]
    assert entry["task"] == "apps.core.tasks.guest_purge"
    assert entry["schedule"] == 3600.0
