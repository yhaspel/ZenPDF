import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

pytestmark = pytest.mark.django_db


def test_create_nested_folders(api):
    r = api.post("/api/folders/", {"name": "Work"}, format="json")
    assert r.status_code == 201
    parent = r.json()["id"]
    r2 = api.post("/api/folders/", {"name": "Invoices", "parent": parent}, format="json")
    assert r2.status_code == 201


def test_duplicate_name_same_parent_rejected(api):
    api.post("/api/folders/", {"name": "Work"}, format="json")
    r = api.post("/api/folders/", {"name": "Work"}, format="json")
    assert r.status_code == 400


def test_delete_empty_folder(api):
    fid = api.post("/api/folders/", {"name": "Temp"}, format="json").json()["id"]
    assert api.delete(f"/api/folders/{fid}/").status_code == 204


def test_delete_nonempty_requires_cascade(api, fixture_bytes):
    fid = api.post("/api/folders/", {"name": "Docs"}, format="json").json()["id"]
    upload = SimpleUploadedFile("text.pdf", fixture_bytes("text.pdf"), content_type="application/pdf")
    api.post("/api/documents/", {"file": upload, "folder": fid}, format="multipart")

    r = api.delete(f"/api/folders/{fid}/")
    assert r.status_code == 400

    r2 = api.delete(f"/api/folders/{fid}/?cascade=trash")
    assert r2.status_code == 204
    # documents trashed, not visible in the default library
    assert api.get("/api/documents/").json()["count"] == 0
    assert api.get("/api/documents/?trashed=true").json()["count"] == 1
