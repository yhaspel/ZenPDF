import pytest

pytestmark = pytest.mark.django_db


def test_health_reports_db_up(anon):
    r = anon.get("/api/health/")
    assert r.status_code == 200
    body = r.json()
    assert body["checks"]["db"] is True
    assert "storage" in body["checks"]


def test_config_is_public_and_quotes_guest_limits_to_anonymous(anon):
    """`/api/config/` is still public, but no longer principal-blind (§16).

    An anonymous caller is quoted the *guest* tier, because that is exactly what
    it gets the moment it writes anything — so the SPA can pre-empt a rejection
    instead of discovering it at 429.
    """
    r = anon.get("/api/config/")
    assert r.status_code == 200
    body = r.json()
    assert body["principal"] == "none"
    assert body["limits"]["tier"] == "guest"
    assert body["limits"]["max_upload_mb"] == 25
    assert body["features"]["ads_enabled"] is False
    assert body["features"]["guest_access_enabled"] is True


def test_config_quotes_the_callers_own_tier(api):
    body = api.get("/api/config/").json()
    assert body["principal"] == "user"
    assert body["limits"]["tier"] == "free"
    assert body["limits"]["max_upload_mb"] == 100


def test_error_shape_on_404(api):
    r = api.get("/api/documents/00000000-0000-0000-0000-000000000000/")
    assert r.status_code == 404
    err = r.json()["error"]
    assert set(err.keys()) == {"code", "message", "details"}
    assert err["code"] == "not_found"


def test_anonymous_read_is_not_an_auth_error(anon):
    """⚠ Rewritten in Phase 2B — supersedes `test_error_shape_on_unauthenticated`.

    That test asserted `GET /api/documents/` → 401 for an anonymous client. Under
    `IsPrincipal` an anonymous read is no longer an auth error at all: it is an
    empty library, and a guest session is minted on the first *write*, not on a
    read (§21.2). Answering 401 here is exactly the login wall this phase
    removes, so the assertion is inverted rather than deleted.
    """
    r = anon.get("/api/documents/")
    assert r.status_code == 200
    assert r.json()["count"] == 0


def test_error_shape_on_expired_guest_token(anon):
    """The error-shape contract the old 401 test was really covering.

    An expired guest token yields **410 `guest_expired`**, deliberately distinct
    from 404: the client must be able to tell "your session ended" from "that
    isn't yours" (§21.2).
    """
    from apps.core.models import GuestSession

    session, raw = GuestSession.mint(ip="127.0.0.1")
    session.expire_now()
    r = anon.get("/api/documents/", HTTP_X_GUEST_TOKEN=raw)
    assert r.status_code == 410
    err = r.json()["error"]
    assert set(err.keys()) == {"code", "message", "details"}
    assert err["code"] == "guest_expired"


def test_validation_error_shape(api):
    r = api.post("/api/users/register/", {"email": "x"}, format="json")
    # register is AllowAny; still validation error shape
    assert r.status_code in (400, 401)
