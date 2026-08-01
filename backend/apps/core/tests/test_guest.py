"""Guest sessions end to end (01-architecture.md §21.2, §21.4)."""
from __future__ import annotations

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

from apps.core.models import GuestSession, hash_guest_token, hash_ip

pytestmark = pytest.mark.django_db


def _upload(client, fixture_bytes, name="text.pdf"):
    upload = SimpleUploadedFile(name, fixture_bytes(name), content_type="application/pdf")
    return client.post("/api/documents/", {"file": upload}, format="multipart")


# --------------------------------------------------------------------------- #
# Lazy minting (§21.2)
# --------------------------------------------------------------------------- #
def test_reads_never_mint_a_session(guest):
    """A bounced visitor must cost zero rows."""
    assert guest.get("/api/documents/").status_code == 200
    assert guest.get("/api/config/").status_code == 200
    assert guest.get("/api/jobs/").status_code == 200
    assert GuestSession.objects.count() == 0
    assert guest.token is None


def test_first_write_mints_and_returns_the_token_once(guest, fixture_bytes):
    resp = _upload(guest, fixture_bytes)
    assert resp.status_code == 201
    assert resp.headers["X-Guest-Token"]
    assert GuestSession.objects.count() == 1

    minted = resp.headers["X-Guest-Token"]
    # Only the hash is persisted — the raw token is never stored (§9).
    session = GuestSession.objects.get()
    assert session.token_hash == hash_guest_token(minted)
    assert minted not in str(session.__dict__)

    # Issued exactly once: a later request re-uses it and re-mints nothing.
    again = _upload(guest, fixture_bytes)
    assert again.status_code == 201
    assert "X-Guest-Token" not in again.headers
    assert GuestSession.objects.count() == 1


def test_probing_document_ids_never_mints_a_session(anon, uploaded_doc):
    """Only a genuine first write may create a row.

    Operations, reverts and cross-document ops all target a document the caller
    must already own, so they must not mint: otherwise anyone POSTing at random
    document ids creates a GuestSession per probe and then gets a 404 anyway.
    """
    doc_id = uploaded_doc["id"]
    probes = [
        ("post", f"/api/documents/{doc_id}/operations/",
         {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90}}),
        ("post", f"/api/documents/{doc_id}/versions/1/revert/", {}),
        ("post", "/api/operations/",
         {"type": "merge", "params": {"document_ids": [doc_id, doc_id]}}),
        ("post", f"/api/documents/{'0' * 8}-0000-0000-0000-000000000000/operations/",
         {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90}}),
    ]
    for method, path, body in probes:
        resp = getattr(anon, method)(path, body, format="json")
        assert resp.status_code == 404, f"{path} → {resp.status_code}"
        assert "X-Guest-Token" not in resp.headers
    assert GuestSession.objects.count() == 0


def test_explicit_mint_endpoint(anon):
    resp = anon.post("/api/guest/session/")
    assert resp.status_code == 201
    body = resp.json()
    assert body["limits"]["tier"] == "guest"
    assert body["seconds_remaining"] > 0
    assert resp.headers["X-Guest-Token"]


def test_explicit_mint_endpoint_inspects_an_existing_session(guest_session, anon):
    session, raw = guest_session
    resp = anon.post("/api/guest/session/", HTTP_X_GUEST_TOKEN=raw)
    assert resp.status_code == 200
    assert resp.json()["id"] == str(session.id)
    assert GuestSession.objects.count() == 1


# --------------------------------------------------------------------------- #
# The whole product, with no account
# --------------------------------------------------------------------------- #
def test_guest_can_run_the_full_document_lifecycle(guest, guest_doc):
    doc_id = guest_doc["id"]
    assert guest.get(f"/api/documents/{doc_id}/").status_code == 200
    assert guest.get(f"/api/documents/{doc_id}/content/").status_code == 200
    assert guest.get(f"/api/documents/{doc_id}/download/").status_code == 200
    assert guest.get(f"/api/documents/{doc_id}/versions/").status_code == 200
    assert guest.get(f"/api/documents/{doc_id}/outline/").status_code == 200
    assert guest.get(f"/api/documents/{doc_id}/text-search/?q=a").status_code == 200
    assert guest.get(f"/api/documents/{doc_id}/pages/0/thumbnail/").status_code == 200
    assert guest.patch(
        f"/api/documents/{doc_id}/", {"title": "Renamed"}, format="json"
    ).status_code == 200
    assert guest.get("/api/documents/").json()["count"] == 1


@pytest.mark.parametrize(
    "op_type,params",
    [
        ("rotate_pages", {"pages": [0], "degrees": 90}),
        ("delete_pages", {"pages": [0]}),
        ("duplicate_pages", {"pages": [0]}),
        ("compress", {"preset": "light"}),
        ("nup", {"per_sheet": 2}),
    ],
)
def test_guest_can_run_page_operations_with_no_login_prompt(
    guest, guest_doc, op_type, params
):
    """The file-in → file-out rule (§21.1): none of these may need an account."""
    resp = guest.post(
        f"/api/documents/{guest_doc['id']}/operations/",
        {"type": op_type, "params": params},
        format="json",
    )
    assert resp.status_code == 202, resp.content
    job = resp.json()
    assert guest.get(f"/api/jobs/{job['id']}/").json()["status"] == "succeeded"


def test_guest_usage_endpoint_reports_session_state(guest, guest_doc):
    body = guest.get("/api/users/me/usage/").json()
    assert body["principal"] == "guest"
    assert body["tier"] == "guest"
    assert body["storage"]["used_bytes"] > 0
    assert body["storage"]["quota_bytes"] == 200 * 1024 * 1024
    assert body["session"]["seconds_remaining"] > 0


def test_config_reflects_the_guest_principal(guest, guest_doc):
    body = guest.get("/api/config/").json()
    assert body["principal"] == "guest"
    assert body["limits"]["tier"] == "guest"
    assert body["guest"]["seconds_remaining"] > 0


# --------------------------------------------------------------------------- #
# Account-only surfaces (§21.3)
# --------------------------------------------------------------------------- #
def test_folders_are_account_only_with_a_reason(guest, guest_doc):
    resp = guest.get("/api/folders/")
    assert resp.status_code == 403
    err = resp.json()["error"]
    assert err["code"] == "account_required"
    # The UI turns this into a signup prompt, so the copy has to say what the
    # account unlocks — never a bare wall (§21.3).
    assert "account" in err["message"].lower()


def test_me_is_account_only(guest, guest_doc):
    assert guest.get("/api/users/me/").json()["error"]["code"] == "account_required"


# --------------------------------------------------------------------------- #
# Expiry (§21.4)
# --------------------------------------------------------------------------- #
def test_expired_token_is_410_not_404(anon, guest_session):
    session, raw = guest_session
    session.expire_now()
    resp = anon.get("/api/documents/", HTTP_X_GUEST_TOKEN=raw)
    assert resp.status_code == 410
    assert resp.json()["error"]["code"] == "guest_expired"


def test_unknown_token_is_410_not_401(anon):
    """An unknown token is indistinguishable from a purged one, and "your
    session ended" is the truthful answer for both. A 401 would send the SPA
    into the login redirect this phase exists to remove."""
    resp = anon.get("/api/documents/", HTTP_X_GUEST_TOKEN="not-a-real-token")
    assert resp.status_code == 410
    assert resp.json()["error"]["code"] == "guest_expired"


def test_ttl_slides_on_use_but_is_capped(guest, guest_doc, settings):
    session = GuestSession.objects.get()
    first = session.expires_at
    # Pretend the session is old enough that the 72 h cap binds.
    from datetime import timedelta

    from django.utils import timezone

    GuestSession.objects.filter(pk=session.pk).update(
        created_at=timezone.now() - timedelta(hours=71)
    )
    session.refresh_from_db()
    session.touch()
    session.refresh_from_db()
    cap = session.created_at + timedelta(hours=settings.GUEST_TTL_MAX_HOURS)
    assert session.expires_at <= cap
    assert session.expires_at != first


def test_ip_hash_is_salted_and_not_reversible(settings):
    plain = "198.51.100.7"
    hashed = hash_ip(plain)
    assert hashed and plain not in hashed
    settings.GUEST_IP_HASH_SALT = "rotated"
    assert hash_ip(plain) != hashed
