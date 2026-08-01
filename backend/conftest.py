"""Shared pytest fixtures (01-architecture.md §18)."""
from pathlib import Path

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

FIXTURES = Path(__file__).resolve().parent / "tests" / "fixtures" / "pdfs"


def _bearer(client: APIClient, user) -> APIClient:
    token = RefreshToken.for_user(user).access_token
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
    return client


@pytest.fixture(autouse=True)
def _reset_rate_windows():
    """Throttle buckets and metered-op windows live in the cache and are keyed
    on the salted IP hash, which is identical for every test client. Without
    this the suite becomes order-dependent: whichever test runs 40th gets a 429
    that has nothing to do with what it is asserting."""
    from django.core.cache import cache

    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def fixture_bytes():
    def _load(name: str) -> bytes:
        return (FIXTURES / name).read_bytes()

    return _load


@pytest.fixture
def user(db):
    return get_user_model().objects.create_user(
        email="alice@example.com", password="pass12345", display_name="Alice"
    )


@pytest.fixture
def other_user(db):
    return get_user_model().objects.create_user(
        email="bob@example.com", password="pass12345", display_name="Bob"
    )


@pytest.fixture
def api(user):
    return _bearer(APIClient(), user)


@pytest.fixture
def other_api(other_user):
    return _bearer(APIClient(), other_user)


@pytest.fixture
def anon():
    return APIClient()


class GuestClient(APIClient):
    """An APIClient that behaves like the SPA (§21.2).

    Sends `X-Guest-Token` once it has one, and captures a freshly minted token
    off the response header of the first write. Modelling the real client this
    way is what makes "minting is lazy — writes only" testable: if a read ever
    minted, `self.token` would be set before any POST.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.token: str | None = None

    def generic(self, method, path, *args, **kwargs):
        if self.token:
            kwargs.setdefault("HTTP_X_GUEST_TOKEN", self.token)
        response = super().generic(method, path, *args, **kwargs)
        minted = response.headers.get("X-Guest-Token")
        if minted:
            self.token = minted
        return response


@pytest.fixture
def guest(db):
    return GuestClient()


@pytest.fixture
def other_guest(db):
    return GuestClient()


@pytest.fixture
def guest_session(db):
    """A minted session plus its raw token, for tests that need one up front."""
    from apps.core.models import GuestSession

    session, raw = GuestSession.mint(ip="203.0.113.10", user_agent="pytest")
    return session, raw


@pytest.fixture
def guest_doc(guest, fixture_bytes):
    """Upload text.pdf as a guest — the write that mints the session."""
    from django.core.files.uploadedfile import SimpleUploadedFile

    upload = SimpleUploadedFile(
        "text.pdf", fixture_bytes("text.pdf"), content_type="application/pdf"
    )
    resp = guest.post("/api/documents/", {"file": upload}, format="multipart")
    assert resp.status_code == 201, resp.content
    return resp.json()


@pytest.fixture
def uploaded_doc(api, fixture_bytes):
    """Upload text.pdf as `user` and return the document JSON."""
    from django.core.files.uploadedfile import SimpleUploadedFile

    upload = SimpleUploadedFile("text.pdf", fixture_bytes("text.pdf"), content_type="application/pdf")
    resp = api.post("/api/documents/", {"file": upload}, format="multipart")
    assert resp.status_code == 201, resp.content
    return resp.json()
