"""Phase-6 API surface: OCR, conversion, compare, repair.

Guest parity alongside every account path — §20 DoD item 9. These four are the
`METERED_OPS` set (§16), so the tests also pin that a guest is metered rather
than blocked.
"""
import io
import zipfile

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

pytestmark = pytest.mark.django_db


def _op(client, doc_id, type_, params, base_seq=1):
    resp = client.post(
        f"/api/documents/{doc_id}/operations/",
        {"type": type_, "params": params, "base_version_seq": base_seq},
        format="json",
    )
    assert resp.status_code == 202, resp.content
    return client.get(f"/api/jobs/{resp.json()['id']}/").json()


def _upload(client, name, data, content_type="application/pdf"):
    upload = SimpleUploadedFile(name, data, content_type=content_type)
    resp = client.post("/api/documents/", {"file": upload}, format="multipart")
    assert resp.status_code == 201, resp.content
    return resp.json()


def _download(client, job_id):
    resp = client.get(f"/api/jobs/{job_id}/download/")
    assert resp.status_code == 200, resp.content
    return resp


@pytest.fixture
def scan(api, fixture_bytes):
    return _upload(api, "scan.pdf", fixture_bytes("scanned.pdf"))


# --------------------------------------------------------------------------- #
# OCR
# --------------------------------------------------------------------------- #
def test_ocr_makes_the_text_readable_and_labels_the_version(api, scan):
    job = _op(api, scan["id"], "ocr", {"languages": ["eng"]})
    assert job["status"] == "succeeded", job
    assert job["result"]["report"]["has_text"] is True

    versions = api.get(f"/api/documents/{scan['id']}/versions/").json()
    assert versions[0]["label"] == "OCR (eng)"

    # The Phase-4 editor was refusing this document; now it must not.
    blocks = api.get(f"/api/documents/{scan['id']}/text-blocks/?page=0").json()
    assert blocks["is_scanned_page"] is False
    assert blocks["blocks"]


def test_a_guest_runs_ocr(guest, fixture_bytes):
    doc = _upload(guest, "scan.pdf", fixture_bytes("scanned.pdf"))
    job = _op(guest, doc["id"], "ocr", {"languages": ["eng"]})
    assert job["status"] == "succeeded", job


def test_an_uninstalled_language_fails_the_job_with_a_useful_message(api, scan):
    job = _op(api, scan["id"], "ocr", {"languages": ["klingon"]})
    assert job["status"] == "failed"
    assert "klingon" in job["error_message"]


def test_ocr_params_are_validated_before_a_job_exists(api, scan):
    from apps.jobs.models import Job

    resp = api.post(f"/api/documents/{scan['id']}/operations/",
                    {"type": "ocr", "params": {"languages": []}}, format="json")
    assert resp.status_code == 400
    assert Job.objects.count() == 0


# --------------------------------------------------------------------------- #
# Export (convert_to)
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("target,expected", [
    ("txt", "text/plain"),
    ("md", "text/markdown"),
    ("html", "text/html"),
    ("images", "application/zip"),
])
def test_every_cheap_export_downloads(api, uploaded_doc, target, expected):
    job = _op(api, uploaded_doc["id"], "convert_to", {"format": target, "dpi": 72})
    assert job["status"] == "succeeded", job
    export = job["result"]["export"]
    assert export["size_bytes"] > 0

    resp = _download(api, job["id"])
    assert resp["Content-Type"].startswith(expected)
    assert "attachment" in resp["Content-Disposition"]


def test_an_export_does_not_mint_a_version(api, uploaded_doc):
    """A Word file is not a state this document could advance to — it is an
    artefact beside it (§15)."""
    before = api.get(f"/api/documents/{uploaded_doc['id']}/versions/").json()
    _op(api, uploaded_doc["id"], "convert_to", {"format": "txt"})
    after = api.get(f"/api/documents/{uploaded_doc['id']}/versions/").json()
    assert len(after) == len(before)


def test_the_image_export_zip_has_one_entry_per_page(api, uploaded_doc):
    job = _op(api, uploaded_doc["id"], "convert_to",
              {"format": "images", "dpi": 72, "image_format": "png"})
    resp = _download(api, job["id"])
    with zipfile.ZipFile(io.BytesIO(resp.content)) as archive:
        assert len(archive.namelist()) == 3


def test_a_guest_exports_and_downloads(guest, guest_doc):
    job = _op(guest, guest_doc["id"], "convert_to", {"format": "txt"})
    assert job["status"] == "succeeded", job
    resp = _download(guest, job["id"])
    assert b"quick brown fox" in resp.content


def test_another_principal_cannot_download_an_export(api, other_api, uploaded_doc):
    job = _op(api, uploaded_doc["id"], "convert_to", {"format": "txt"})
    assert other_api.get(f"/api/jobs/{job['id']}/download/").status_code == 404


def test_a_job_with_no_export_has_no_download(api, uploaded_doc):
    job = _op(api, uploaded_doc["id"], "rotate_pages", {"pages": [0], "degrees": 90})
    assert api.get(f"/api/jobs/{job['id']}/download/").status_code == 404


def test_pdfa_export_claims_conformance(api, uploaded_doc):
    job = _op(api, uploaded_doc["id"], "convert_to", {"format": "pdfa"})
    assert job["status"] == "succeeded", job
    assert job["result"]["report"]["claims_pdfa"] is True
    assert _download(api, job["id"])["Content-Type"] == "application/pdf"


# --------------------------------------------------------------------------- #
# Import (convert_from)
# --------------------------------------------------------------------------- #
def _png(size=(120, 80)) -> bytes:
    import fitz

    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, *size))
    pix.set_rect(pix.irect, (10, 120, 200))
    return pix.tobytes("png")


def _upload_source(client, name, data, content_type="application/octet-stream"):
    upload = SimpleUploadedFile(name, data, content_type=content_type)
    resp = client.post("/api/uploads/source/", {"file": upload}, format="multipart")
    assert resp.status_code == 201, resp.content
    return resp.json()


def _cross(client, type_, params):
    resp = client.post("/api/operations/", {"type": type_, "params": params},
                       format="json")
    assert resp.status_code == 202, resp.content
    return client.get(f"/api/jobs/{resp.json()['id']}/").json()


def test_an_image_import_becomes_a_document(api):
    asset = _upload_source(api, "holiday.png", _png(), "image/png")
    job = _cross(api, "convert_from", {"upload_ref": asset["ref"],
                                       "filename": "holiday.png"})
    assert job["status"] == "succeeded", job
    doc_id = job["result"]["documents"][0]
    detail = api.get(f"/api/documents/{doc_id}/").json()
    assert detail["page_count"] == 1
    assert detail["title"] == "holiday"


def test_a_guest_imports_an_image(guest):
    asset = _upload_source(guest, "photo.png", _png(), "image/png")
    job = _cross(guest, "convert_from", {"upload_ref": asset["ref"],
                                         "filename": "photo.png"})
    assert job["status"] == "succeeded", job


def test_a_file_type_we_cannot_convert_is_refused_at_upload(api):
    upload = SimpleUploadedFile("virus.exe", b"MZ", content_type="application/octet-stream")
    resp = api.post("/api/uploads/source/", {"file": upload}, format="multipart")
    assert resp.status_code == 400
    assert "convert" in resp.json()["error"]["message"]


def test_one_principal_cannot_convert_another_principals_upload(api, other_api):
    asset = _upload_source(api, "mine.png", _png(), "image/png")
    job = _cross(other_api, "convert_from", {"upload_ref": asset["ref"],
                                             "filename": "mine.png"})
    # The key is derived from the *caller's* principal, so the ref simply is not
    # there for anyone else (§13).
    assert job["status"] == "failed"


@pytest.mark.parametrize("url", [
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:8000/api/documents/",
    "file:///etc/passwd",
    "http://10.1.2.3/internal",
])
def test_url_conversion_refuses_the_private_space_before_a_job_exists(api, url):
    """Acceptance criterion 4, at the edge: an immediate 400, not a job that
    fails a minute later."""
    from apps.jobs.models import Job

    resp = api.post("/api/operations/",
                    {"type": "convert_from", "params": {"url": url}}, format="json")
    assert resp.status_code == 400, resp.content
    assert Job.objects.count() == 0


def test_convert_from_needs_something_to_convert(api):
    resp = api.post("/api/operations/", {"type": "convert_from", "params": {}},
                    format="json")
    assert resp.status_code == 400


# --------------------------------------------------------------------------- #
# Compare
# --------------------------------------------------------------------------- #
def test_compare_reports_the_difference_and_mints_no_version(api, fixture_bytes):
    a = _upload(api, "a.pdf", fixture_bytes("compare-a.pdf"))
    b = _upload(api, "b.pdf", fixture_bytes("compare-b.pdf"))
    before = api.get(f"/api/documents/{a['id']}/versions/").json()

    job = _op(api, a["id"], "compare", {"other_document_id": b["id"]})
    assert job["status"] == "succeeded", job
    report = job["result"]["report"]
    assert report["summary"]["identical"] is False
    assert report["summary"]["text_changes"] > 0
    assert any(p["visual_regions"] for p in report["pages"])

    after = api.get(f"/api/documents/{a['id']}/versions/").json()
    assert len(after) == len(before), "compare inspects; it must not mint a version"


def test_compare_against_a_document_the_caller_does_not_own(api, other_api,
                                                            fixture_bytes, uploaded_doc):
    """The source id is resolved in the *worker*, scoped to the job's principal,
    so the job fails `not_found` — the same shape `overlay_pdf` and
    `insert_from_document` have had since phases 2 and 4. Nothing of the other
    principal's document is read, and the failure says nothing about whether
    that id exists."""
    theirs = _upload(other_api, "theirs.pdf", fixture_bytes("compare-b.pdf"))
    job = _op(api, uploaded_doc["id"], "compare", {"other_document_id": theirs["id"]})
    assert job["status"] == "failed"
    assert job["error_code"] == "not_found"


def test_a_guest_compares_two_of_its_own_documents(guest, fixture_bytes):
    a = _upload(guest, "a.pdf", fixture_bytes("compare-a.pdf"))
    b = _upload(guest, "b.pdf", fixture_bytes("compare-b.pdf"))
    job = _op(guest, a["id"], "compare", {"other_document_id": b["id"]})
    assert job["status"] == "succeeded", job


# --------------------------------------------------------------------------- #
# Repair
# --------------------------------------------------------------------------- #
def _upload_damaged(client, fixture_bytes):
    """`corrupt.pdf` is refused at ingest with a repair offer (the phase-01
    flow), so getting it into the library at all means taking that offer."""
    upload = SimpleUploadedFile("damaged.pdf", fixture_bytes("corrupt.pdf"),
                                content_type="application/pdf")
    resp = client.post("/api/documents/?repair=true", {"file": upload},
                       format="multipart")
    assert resp.status_code == 201, resp.content
    return resp.json()


def test_repair_produces_a_clean_version(api, fixture_bytes):
    doc = _upload_damaged(api, fixture_bytes)
    job = _op(api, doc["id"], "repair", {})
    assert job["status"] == "succeeded", job
    assert api.get(f"/api/documents/{doc['id']}/versions/").json()[0]["label"] == "Repaired"


def test_a_guest_repairs_a_document(guest, fixture_bytes):
    doc = _upload_damaged(guest, fixture_bytes)
    job = _op(guest, doc["id"], "repair", {})
    assert job["status"] == "succeeded", job


# --------------------------------------------------------------------------- #
# Metering (§16) — these four are METERED_OPS, and a guest is *metered*, not
# blocked: the anonymous-first strategy is the whole point (§21.1).
# --------------------------------------------------------------------------- #
def test_the_phase_six_ops_are_the_metered_set():
    from apps.core.limits import METERED_OPS

    assert METERED_OPS == {"ocr", "convert_from", "convert_to", "compare"}


def test_a_guest_is_metered_not_blocked(guest, guest_doc, settings):
    """The hourly window is enforced; the first calls go through."""
    for _ in range(2):
        job = _op(guest, guest_doc["id"], "convert_to", {"format": "txt"})
        assert job["status"] == "succeeded", job
