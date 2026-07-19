"""Cross-user isolation applied router-wide (phase-01 acceptance).

A second account must not reach the first account's document through ANY
per-document endpoint. Owner-scoped querysets → 404 for everyone else.
"""
import pytest

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


def test_other_user_gets_404_everywhere(uploaded_doc, other_api):
    doc_id = uploaded_doc["id"]
    for method, path in _endpoints(doc_id):
        resp = getattr(other_api, method)(path, {}, format="json") if method in ("patch", "post") \
            else getattr(other_api, method)(path)
        assert resp.status_code == 404, f"{method.upper()} {path} → {resp.status_code}"


def test_owner_can_access(api, uploaded_doc):
    doc_id = uploaded_doc["id"]
    assert api.get(f"/api/documents/{doc_id}/").status_code == 200


def test_list_excludes_other_users_docs(uploaded_doc, other_api):
    assert other_api.get("/api/documents/").json()["count"] == 0
