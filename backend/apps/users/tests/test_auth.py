import pytest
from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db


def test_register_login_me_refresh_flow(anon):
    r = anon.post("/api/users/register/",
                  {"email": "NEW@Example.com", "password": "strongpass123", "display_name": "New"},
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
                  {"email": "Alice@Example.com", "password": "strongpass123"}, format="json")
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "validation_error"


def test_register_weak_password(anon):
    r = anon.post("/api/users/register/",
                  {"email": "weak@example.com", "password": "123"}, format="json")
    assert r.status_code == 400


def test_me_patch_display_name(api):
    r = api.patch("/api/users/me/", {"display_name": "Renamed"}, format="json")
    assert r.status_code == 200
    assert r.json()["display_name"] == "Renamed"


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
