"""No browser may replay an API answer meant for a different principal (§9, §21.2).

The bug this covers took the whole product down for anybody who came back the
next day. A guest token expires after 24 h; the first `GET /api/config/` made
with it answers `410 guest_expired`; that response carried no `Cache-Control`,
so Chrome stored it heuristically, keyed on the URL and `Vary: Accept, origin`
— which does not include the credential. Every later request to that URL was
then answered 410 *from cache*, with a token minted seconds earlier, so the
client cleared each fresh session as fast as it created one. Uploads landed in
sessions nothing could read, and the workspace showed "An error occurred."
"""
import pytest

pytestmark = pytest.mark.django_db


def test_an_api_error_is_never_stored(anon):
    """A 410 or 404 is about *this* credential, and must not outlive it."""
    from apps.core.models import GuestSession

    session, raw = GuestSession.mint(ip="127.0.0.1")
    session.expire_now()
    r = anon.get("/api/config/", HTTP_X_GUEST_TOKEN=raw)
    assert r.status_code == 410
    assert r["Cache-Control"] == "no-store"

    missing = anon.get("/api/documents/00000000-0000-0000-0000-000000000000/")
    assert missing.status_code == 404
    assert missing["Cache-Control"] == "no-store"


def test_a_successful_api_answer_is_private_and_unstored_by_default(anon):
    r = anon.get("/api/config/")
    assert r.status_code == 200
    assert r["Cache-Control"] == "private, no-store"


def test_a_view_that_chose_its_own_caching_keeps_it(anon, fixture_bytes):
    """A page raster is pinned to a version and is worth caching — the rule is
    "never store an error", not "never cache anything"."""
    from django.core.files.uploadedfile import SimpleUploadedFile

    up = anon.post(
        "/api/documents/",
        {"file": SimpleUploadedFile("a.pdf", fixture_bytes("text.pdf"), content_type="application/pdf")},
        format="multipart",
    )
    assert up.status_code == 201
    token = up["X-Guest-Token"]
    doc_id = up.json()["id"]
    thumb = anon.get(f"/api/documents/{doc_id}/pages/0/thumbnail/", HTTP_X_GUEST_TOKEN=token)
    assert thumb.status_code == 200
    assert "max-age" in thumb["Cache-Control"]
    assert thumb["Cache-Control"].startswith("private")


def test_a_page_outside_the_api_is_left_alone(anon):
    """The middleware is scoped to `/api/`; the SPA's own caching is nginx's."""
    r = anon.get("/api/health/")
    assert r["Cache-Control"] == "private, no-store"


def test_a_missing_thing_says_something_a_person_can_act_on(api):
    """`Http404` reaches the handler with no `detail` at all, so every "not
    yours / already deleted / wrong id" used to arrive as the words "An error
    occurred." — which names nothing and suggests nothing."""
    r = api.get("/api/documents/00000000-0000-0000-0000-000000000000/")
    assert r.status_code == 404
    message = r.json()["error"]["message"]
    assert message != "An error occurred."
    assert "could not find" in message.lower()
