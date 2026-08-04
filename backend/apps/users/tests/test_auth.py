import pytest
from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db


def test_register_login_me_refresh_flow(anon):
    r = anon.post("/api/users/register/",
                  {"email": "NEW@Example.com", "password": "strongpass123",
                   "display_name": "New", "accept_terms": True},
                  format="json")
    assert r.status_code == 201, r.content
    assert r.json()["email"] == "new@example.com"  # normalized lowercase

    r = anon.post("/api/auth/login/",
                  {"email": "new@example.com", "password": "strongpass123"}, format="json")
    assert r.status_code == 200
    tokens = r.json()
    assert "access" in tokens and "refresh" in tokens

    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")
    r = client.get("/api/users/me/")
    assert r.status_code == 200
    assert r.json()["email"] == "new@example.com"

    r = APIClient().post("/api/auth/refresh/", {"refresh": tokens["refresh"]}, format="json")
    assert r.status_code == 200
    assert "access" in r.json()


def test_login_wrong_password(anon, user):
    r = anon.post("/api/auth/login/",
                  {"email": "alice@example.com", "password": "wrong"}, format="json")
    assert r.status_code == 401


def test_register_duplicate_email(anon, user):
    r = anon.post("/api/users/register/",
                  {"email": "Alice@Example.com", "password": "strongpass123", "accept_terms": True}, format="json")
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "validation_error"


def test_register_weak_password(anon):
    r = anon.post("/api/users/register/",
                  {"email": "weak@example.com", "password": "123", "accept_terms": True}, format="json")
    assert r.status_code == 400


def test_me_patch_display_name(api):
    r = api.patch("/api/users/me/", {"display_name": "Renamed"}, format="json")
    assert r.status_code == 200
    assert r.json()["display_name"] == "Renamed"


def test_the_tos_consent_timestamp_cannot_be_rewritten(api, user):
    """L6 — it is evidence, and the point of a timestamp is that it stands.

    `accepted_tos_at` was writable through the profile serializer, so the
    account could clear its own record of having agreed to the terms (§9A).
    """
    from django.utils import timezone

    user.accepted_tos_at = timezone.now()
    user.save(update_fields=["accepted_tos_at"])
    original = user.accepted_tos_at

    for attempt in (None, "2000-01-01T00:00:00Z"):
        r = api.patch("/api/users/me/", {"accepted_tos_at": attempt},
                      format="json")
        # Read-only fields are ignored rather than rejected, which is the DRF
        # convention the rest of this serializer already follows.
        assert r.status_code == 200, r.content
        user.refresh_from_db()
        assert user.accepted_tos_at == original


def test_logout_blacklists_refresh(anon, user):
    tokens = anon.post("/api/auth/login/",
                       {"email": "alice@example.com", "password": "pass12345"},
                       format="json").json()
    r = anon.post("/api/auth/logout/", {"refresh": tokens["refresh"]}, format="json")
    assert r.status_code == 200
    # blacklisted refresh can no longer mint access tokens
    r = APIClient().post("/api/auth/refresh/", {"refresh": tokens["refresh"]}, format="json")
    assert r.status_code == 401


def test_usage_endpoint(api):
    r = api.get("/api/users/me/usage/")
    assert r.status_code == 200
    body = r.json()
    assert body["storage"]["quota_bytes"] == 2048 * 1024 * 1024
    assert body["counters"]["ocr_pages"] == 0
