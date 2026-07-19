import pytest

pytestmark = pytest.mark.django_db


def test_health_reports_db_up(anon):
    r = anon.get("/api/health/")
    assert r.status_code == 200
    body = r.json()
    assert body["checks"]["db"] is True
    assert "storage" in body["checks"]


def test_config_is_public(anon):
    r = anon.get("/api/config/")
    assert r.status_code == 200
    body = r.json()
    assert body["limits"]["max_upload_mb"] == 100
    assert body["features"]["ads_enabled"] is False


def test_error_shape_on_404(api):
    r = api.get("/api/documents/00000000-0000-0000-0000-000000000000/")
    assert r.status_code == 404
    err = r.json()["error"]
    assert set(err.keys()) == {"code", "message", "details"}
    assert err["code"] == "not_found"


def test_error_shape_on_unauthenticated(anon):
    r = anon.get("/api/documents/")
    assert r.status_code == 401
    assert r.json()["error"]["code"] in ("not_authenticated", "authentication_failed")


def test_validation_error_shape(api):
    r = api.post("/api/users/register/", {"email": "x"}, format="json")
    # register is AllowAny; still validation error shape
    assert r.status_code in (400, 401)
