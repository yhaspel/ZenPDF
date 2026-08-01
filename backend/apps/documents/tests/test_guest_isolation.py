"""Router-wide guest isolation — the guest twin of `test_isolation.py` (§21.2).

Proves all three crossings: guest ↛ guest, guest ↛ user, user ↛ guest. Every
per-document endpoint, not a sample: the failure mode this guards against is one
missed queryset, and a sample is exactly how a missed queryset survives.
"""
import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

pytestmark = pytest.mark.django_db


def _endpoints(doc_id):
    return [
        ("get", f"/api/documents/{doc_id}/"),
        ("get", f"/api/documents/{doc_id}/content/"),
        ("get", f"/api/documents/{doc_id}/download/"),
        ("get", f"/api/documents/{doc_id}/pages/0/thumbnail/"),
        ("get", f"/api/documents/{doc_id}/versions/"),
        ("get", f"/api/documents/{doc_id}/outline/"),
        ("get", f"/api/documents/{doc_id}/text-search/?q=x"),
        ("patch", f"/api/documents/{doc_id}/"),
        ("delete", f"/api/documents/{doc_id}/"),
        ("post", f"/api/documents/{doc_id}/restore/"),
        ("post", f"/api/documents/{doc_id}/versions/1/revert/"),
        ("post", f"/api/documents/{doc_id}/operations/"),
    ]


def _hit(client, method, path):
    if method in ("patch", "post"):
        return getattr(client, method)(path, {}, format="json")
    return getattr(client, method)(path)


def _assert_404_everywhere(client, doc_id, who):
    for method, path in _endpoints(doc_id):
        resp = _hit(client, method, path)
        assert resp.status_code == 404, f"{who}: {method.upper()} {path} → {resp.status_code}"


def _upload_as_guest(client, fixture_bytes):
    upload = SimpleUploadedFile(
        "text.pdf", fixture_bytes("text.pdf"), content_type="application/pdf"
    )
    resp = client.post("/api/documents/", {"file": upload}, format="multipart")
    assert resp.status_code == 201, resp.content
    return resp.json()


def test_guest_cannot_reach_another_guests_document(guest, other_guest, fixture_bytes):
    doc = _upload_as_guest(guest, fixture_bytes)
    # Give guest B its own session, so it is a real principal and not just
    # "anonymous" — the interesting case is two live guests, not guest vs none.
    _upload_as_guest(other_guest, fixture_bytes)
    assert other_guest.token and other_guest.token != guest.token
    _assert_404_everywhere(other_guest, doc["id"], "guest B")


def test_guest_cannot_reach_a_users_document(uploaded_doc, guest, fixture_bytes):
    _upload_as_guest(guest, fixture_bytes)
    _assert_404_everywhere(guest, uploaded_doc["id"], "guest")


def test_user_cannot_reach_a_guests_document(guest, fixture_bytes, api):
    doc = _upload_as_guest(guest, fixture_bytes)
    _assert_404_everywhere(api, doc["id"], "user")


def test_anonymous_caller_with_no_session_reaches_nothing(guest, fixture_bytes, anon):
    """`owned_by(qs, None)` must match nothing.

    The dangerous near-miss is `filter(owner=None)`, which compiles to
    `owner_id IS NULL` — i.e. *every* guest's documents.
    """
    doc = _upload_as_guest(guest, fixture_bytes)
    _assert_404_everywhere(anon, doc["id"], "anonymous")
    assert anon.get("/api/documents/").json()["count"] == 0


def test_lists_are_scoped_per_principal(guest, other_guest, fixture_bytes, api, uploaded_doc):
    _upload_as_guest(guest, fixture_bytes)
    _upload_as_guest(other_guest, fixture_bytes)
    assert guest.get("/api/documents/").json()["count"] == 1
    assert other_guest.get("/api/documents/").json()["count"] == 1
    assert api.get("/api/documents/").json()["count"] == 1


def test_job_lists_are_scoped_per_principal(guest, other_guest, fixture_bytes):
    doc = _upload_as_guest(guest, fixture_bytes)
    _upload_as_guest(other_guest, fixture_bytes)
    job = guest.post(
        f"/api/documents/{doc['id']}/operations/",
        {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90}},
        format="json",
    ).json()

    assert guest.get(f"/api/jobs/{job['id']}/").status_code == 200
    assert other_guest.get(f"/api/jobs/{job['id']}/").status_code == 404
    assert other_guest.get("/api/jobs/").json()["count"] == 0
    assert other_guest.post(f"/api/jobs/{job['id']}/cancel/", {}, format="json").status_code == 404


def test_expired_guest_gets_410_not_404_on_its_own_document(guest, fixture_bytes, anon):
    """The distinction the client depends on: "your session ended" (410) is not
    "that isn't yours" (404)."""
    from apps.core.models import GuestSession

    doc = _upload_as_guest(guest, fixture_bytes)
    GuestSession.objects.get().expire_now()
    resp = anon.get(f"/api/documents/{doc['id']}/", HTTP_X_GUEST_TOKEN=guest.token)
    assert resp.status_code == 410
    assert resp.json()["error"]["code"] == "guest_expired"
