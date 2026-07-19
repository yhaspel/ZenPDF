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


@pytest.fixture
def uploaded_doc(api, fixture_bytes):
    """Upload text.pdf as `user` and return the document JSON."""
    from django.core.files.uploadedfile import SimpleUploadedFile

    upload = SimpleUploadedFile("text.pdf", fixture_bytes("text.pdf"), content_type="application/pdf")
    resp = api.post("/api/documents/", {"file": upload}, format="multipart")
    assert resp.status_code == 201, resp.content
    return resp.json()
