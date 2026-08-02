import pytest

pytestmark = pytest.mark.django_db


def _rotate(api, doc_id, base_seq=1):
    r = api.post(f"/api/documents/{doc_id}/operations/",
                 {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90},
                  "base_version_seq": base_seq}, format="json")
    assert r.status_code == 202
    return api.get(f"/api/jobs/{r.json()['id']}/").json()


def test_version_history_and_revert(api, uploaded_doc):
    doc_id = uploaded_doc["id"]
    job = _rotate(api, doc_id)
    assert job["status"] == "succeeded"
    assert job["result"]["seq"] == 2

    versions = api.get(f"/api/documents/{doc_id}/versions/").json()["results"]
    labels = [v["label"] for v in versions]
    assert "Original" in labels
    assert "Rotated 1 page(s)" in labels

    # revert to v1
    r = api.post(f"/api/documents/{doc_id}/versions/1/revert/", format="json")
    assert r.status_code == 202
    j = api.get(f"/api/jobs/{r.json()['id']}/").json()
    assert j["status"] == "succeeded"
    assert j["result"]["seq"] == 3

    detail = api.get(f"/api/documents/{doc_id}/").json()
    assert detail["current_version"]["seq"] == 3
    assert detail["current_version"]["label"] == "Reverted to v1"


def test_trash_restore_purge_frees_quota(api, uploaded_doc, user):
    doc_id = uploaded_doc["id"]
    user.refresh_from_db()
    used_before = user.storage_bytes_used
    assert used_before > 0

    # trash
    assert api.delete(f"/api/documents/{doc_id}/").status_code == 204
    assert api.get("/api/documents/").json()["count"] == 0
    assert api.get("/api/documents/?trashed=true").json()["count"] == 1

    # restore
    assert api.post(f"/api/documents/{doc_id}/restore/").status_code == 200
    assert api.get("/api/documents/").json()["count"] == 1

    # trash again + permanent purge
    api.delete(f"/api/documents/{doc_id}/")
    assert api.delete(f"/api/documents/{doc_id}/?permanent=true").status_code == 204
    user.refresh_from_db()
    assert user.storage_bytes_used == 0


def test_permanent_delete_requires_trash_first(api, uploaded_doc):
    doc_id = uploaded_doc["id"]
    r = api.delete(f"/api/documents/{doc_id}/?permanent=true")
    assert r.status_code == 400
