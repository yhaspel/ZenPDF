"""Exercise the remaining operation branches (worker dispatch + views)."""
import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

pytestmark = pytest.mark.django_db


def _upload(client, name, data):
    upload = SimpleUploadedFile(name, data, content_type="application/pdf")
    return client.post("/api/documents/", {"file": upload}, format="multipart").json()


def _run(api, doc_id, type_, params):
    r = api.post(f"/api/documents/{doc_id}/operations/",
                 {"type": type_, "params": params}, format="json")
    assert r.status_code == 202, r.content
    return api.get(f"/api/jobs/{r.json()['id']}/").json()


@pytest.mark.parametrize("type_,params", [
    ("duplicate_pages", {"pages": [0]}),
    ("reorder_pages", {"new_order": [2, 1, 0]}),
    ("insert_blank", {"at_index": 1, "count": 1, "size": "a4"}),
    ("nup", {"per_sheet": 2}),
    ("scale_pages", {"pages": [0], "target_size": "letter"}),
    ("crop_pages", {"pages": [0], "rect": {"x": 0.1, "y": 0.1, "w": 0.5, "h": 0.5}}),
    ("compress", {"preset": "light"}),
])
def test_single_document_ops_succeed(api, fixture_bytes, type_, params):
    doc = _upload(api, "text.pdf", fixture_bytes("text.pdf"))
    job = _run(api, doc["id"], type_, params)
    assert job["status"] == "succeeded", job


def test_insert_from_document(api, fixture_bytes):
    target = _upload(api, "t.pdf", fixture_bytes("text.pdf"))
    source = _upload(api, "s.pdf", fixture_bytes("unicode.pdf"))
    job = _run(api, target["id"], "insert_from_document",
               {"source_document_id": source["id"], "source_pages": [0], "at_index": 1})
    assert job["status"] == "succeeded"
    detail = api.get(f"/api/documents/{target['id']}/").json()
    assert detail["page_count"] == 4


def test_alternate_mix_cross_document(api, fixture_bytes):
    a = _upload(api, "a.pdf", fixture_bytes("text.pdf"))
    b = _upload(api, "b.pdf", fixture_bytes("unicode.pdf"))
    r = api.post("/api/operations/",
                 {"type": "alternate_mix",
                  "params": {"document_a": a["id"], "document_b": b["id"], "reverse_b": False}},
                 format="json")
    assert r.status_code == 202
    job = api.get(f"/api/jobs/{r.json()['id']}/").json()
    assert job["status"] == "succeeded"
    new_id = job["result"]["documents"][0]
    assert api.get(f"/api/documents/{new_id}/").json()["page_count"] == 4


def test_rename_and_star(api, uploaded_doc):
    doc_id = uploaded_doc["id"]
    r = api.patch(f"/api/documents/{doc_id}/", {"title": "Renamed", "starred": True}, format="json")
    assert r.status_code == 200
    assert r.json()["title"] == "Renamed"
    assert r.json()["starred"] is True
    assert api.get("/api/documents/?starred=true").json()["count"] == 1


def test_content_specific_version(api, uploaded_doc):
    doc_id = uploaded_doc["id"]
    _run(api, doc_id, "rotate_pages", {"pages": [0], "degrees": 90})
    r = api.get(f"/api/documents/{doc_id}/content/?version=1")
    assert r.status_code == 200
