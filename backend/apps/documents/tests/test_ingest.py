import copy

import pytest
from django.conf import settings as dj_settings
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings

pytestmark = pytest.mark.django_db


def tiers_with(tier: str, **overrides) -> dict:
    """A copy of settings.TIERS with one tier's limits patched.

    Limits resolve from `settings.TIERS` since 2B (§16), so overriding the flat
    `MAX_UPLOAD_MB` env knob no longer changes what a call site enforces —
    TIERS is built from it once, at settings-import time.
    """
    tiers = copy.deepcopy(dj_settings.TIERS)
    tiers[tier].update(overrides)
    return tiers


def _upload(client, name, data, **extra):
    upload = SimpleUploadedFile(name, data, content_type="application/pdf")
    return client.post("/api/documents/", {"file": upload, **extra}, format="multipart")


def test_ingest_happy_path(api, fixture_bytes, user):
    r = _upload(api, "text.pdf", fixture_bytes("text.pdf"))
    assert r.status_code == 201, r.content
    body = r.json()
    assert body["status"] == "ready"
    assert body["page_count"] == 3
    assert body["current_version"]["label"] == "Original"
    assert body["current_version"]["seq"] == 1
    user.refresh_from_db()
    assert user.storage_bytes_used > 0


def test_ingest_stores_metadata(api, fixture_bytes):
    r = _upload(api, "text.pdf", fixture_bytes("text.pdf"))
    assert "metadata" in r.json()


def test_quota_rejected_at_boundary(api, fixture_bytes, user, settings):
    quota_bytes = settings.TIERS["free"]["storage_mb"] * 1024 * 1024
    user.storage_bytes_used = quota_bytes - 10  # any upload will exceed
    user.save()
    r = _upload(api, "text.pdf", fixture_bytes("text.pdf"))
    assert r.status_code == 429
    assert r.json()["error"]["code"] == "quota_exceeded"


def test_file_too_large(api, fixture_bytes):
    with override_settings(TIERS=tiers_with("free", max_upload_mb=0)):
        r = _upload(api, "text.pdf", fixture_bytes("text.pdf"))
    assert r.status_code == 413
    assert r.json()["error"]["code"] == "file_too_large"


def test_not_a_pdf_rejected(api):
    r = _upload(api, "bad.pdf", b"definitely not a pdf")
    assert r.status_code == 415
    assert r.json()["error"]["code"] == "unsupported_file"


def test_corrupt_offers_repair_then_succeeds(api, fixture_bytes):
    corrupt = fixture_bytes("corrupt.pdf")
    r = _upload(api, "corrupt.pdf", corrupt)
    assert r.status_code == 415
    assert r.json()["error"]["details"].get("repair_offer") is True
    # retry with ?repair=true
    upload = SimpleUploadedFile("corrupt.pdf", corrupt, content_type="application/pdf")
    r2 = api.post("/api/documents/?repair=true", {"file": upload}, format="multipart")
    assert r2.status_code == 201
    assert r2.json()["status"] == "ready"


def test_encrypted_flagged_and_ops_blocked(api, fixture_bytes):
    r = _upload(api, "encrypted.pdf", fixture_bytes("encrypted.pdf"))
    assert r.status_code == 201
    assert r.json()["is_encrypted"] is True
    doc_id = r.json()["id"]
    op = api.post(f"/api/documents/{doc_id}/operations/",
                  {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90}},
                  format="json")
    assert op.status_code == 423
    assert op.json()["error"]["code"] == "document_encrypted"
