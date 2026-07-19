import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

pytestmark = pytest.mark.django_db


def _upload(client, name, data, **extra):
    upload = SimpleUploadedFile(name, data, content_type="application/pdf")
    return client.post("/api/documents/", {"file": upload, **extra}, format="multipart").json()


def _op(api, doc_id, type_, params, base_seq=1):
    r = api.post(f"/api/documents/{doc_id}/operations/",
                 {"type": type_, "params": params, "base_version_seq": base_seq}, format="json")
    assert r.status_code == 202, r.content
    return api.get(f"/api/jobs/{r.json()['id']}/").json()


def test_page_op_creates_labeled_version(api, uploaded_doc):
    job = _op(api, uploaded_doc["id"], "delete_pages", {"pages": [1]})
    assert job["status"] == "succeeded"
    detail = api.get(f"/api/documents/{uploaded_doc['id']}/").json()
    assert detail["page_count"] == 2


def test_base_version_conflict(api, uploaded_doc):
    job = _op(api, uploaded_doc["id"], "rotate_pages", {"pages": [0], "degrees": 90}, base_seq=99)
    assert job["status"] == "failed"
    assert job["error_code"] == "version_conflict"


def test_min_one_page_rule(api, uploaded_doc):
    job = _op(api, uploaded_doc["id"], "delete_pages", {"pages": [0, 1, 2]})
    assert job["status"] == "failed"
    assert job["error_code"] == "validation_error"


def test_invalid_params_rejected_before_job(api, uploaded_doc):
    r = api.post(f"/api/documents/{uploaded_doc['id']}/operations/",
                 {"type": "rotate_pages", "params": {"pages": [0], "degrees": 45}}, format="json")
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "validation_error"


def test_extract_as_new_document(api, uploaded_doc):
    job = _op(api, uploaded_doc["id"], "extract_pages",
              {"pages": [0], "as_new_document": True})
    assert job["status"] == "succeeded"
    assert len(job["result"]["documents"]) == 1


def test_split_produces_documents(api, uploaded_doc):
    r = api.post(f"/api/documents/{uploaded_doc['id']}/operations/",
                 {"type": "split", "params": {"mode": "ranges", "ranges": "1,2-3"},
                  "base_version_seq": 1}, format="json")
    job = api.get(f"/api/jobs/{r.json()['id']}/").json()
    assert job["status"] == "succeeded"
    assert len(job["result"]["documents"]) == 2


def test_merge_via_cross_document_endpoint(api, fixture_bytes):
    a = _upload(api, "a.pdf", fixture_bytes("text.pdf"))
    b = _upload(api, "b.pdf", fixture_bytes("unicode.pdf"))
    r = api.post("/api/operations/",
                 {"type": "merge", "params": {"document_ids": [a["id"], b["id"]]}}, format="json")
    assert r.status_code == 202
    job = api.get(f"/api/jobs/{r.json()['id']}/").json()
    assert job["status"] == "succeeded"
    new_id = job["result"]["documents"][0]
    merged = api.get(f"/api/documents/{new_id}/").json()
    assert merged["page_count"] == 4
    assert merged["title"].startswith("Merged —")


def test_merge_rejects_single_source_via_operations(api, uploaded_doc):
    r = api.post("/api/operations/",
                 {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90}}, format="json")
    assert r.status_code == 400  # not a cross-document op


def test_cross_user_cannot_operate(other_api, uploaded_doc):
    r = other_api.post(f"/api/documents/{uploaded_doc['id']}/operations/",
                       {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90}},
                       format="json")
    assert r.status_code == 404
