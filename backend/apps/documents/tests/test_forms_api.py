"""Phase-5 API surface: the form read model, filling, the field builder,
import/export and flatten. Guest parity throughout (§20 DoD item 9).
"""
import json

import fitz
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


def _upload(client, name, data):
    upload = SimpleUploadedFile(name, data, content_type="application/pdf")
    resp = client.post("/api/documents/", {"file": upload}, format="multipart")
    assert resp.status_code == 201, resp.content
    return resp.json()


def _form(client, doc_id) -> dict:
    return client.get(f"/api/documents/{doc_id}/form/").json()


@pytest.fixture
def form_doc(api, fixture_bytes):
    return _upload(api, "form.pdf", fixture_bytes("form.pdf"))


@pytest.fixture
def guest_form_doc(guest, fixture_bytes):
    return _upload(guest, "form.pdf", fixture_bytes("form.pdf"))


# --------------------------------------------------------------------------- #
# Read model
# --------------------------------------------------------------------------- #
def test_form_endpoint_reports_the_fields(api, form_doc):
    body = _form(api, form_doc["id"])
    assert body["has_form"] is True
    assert body["is_xfa"] is False
    assert {f["name"] for f in body["fields"]} == {"full_name", "agree"}


def test_a_document_without_a_form(api, uploaded_doc):
    body = _form(api, uploaded_doc["id"])
    assert body["has_form"] is False
    assert body["fields"] == []


def test_xfa_is_reported_so_the_ui_can_warn(api, fixture_bytes):
    doc = _upload(api, "xfa.pdf", fixture_bytes("xfa-form.pdf"))
    body = _form(api, doc["id"])
    assert body["is_xfa"] is True
    assert body["has_form"] is True


def test_a_guest_can_read_the_form(guest, guest_form_doc):
    assert _form(guest, guest_form_doc["id"])["has_form"] is True


# --------------------------------------------------------------------------- #
# Filling
# --------------------------------------------------------------------------- #
def test_fill_form_creates_a_labeled_version(api, form_doc):
    job = _op(api, form_doc["id"], "fill_form",
              {"values": {"full_name": "Ada Lovelace", "agree": True}})
    assert job["status"] == "succeeded", job
    versions = api.get(f"/api/documents/{form_doc['id']}/versions/").json()
    assert versions[0]["label"] == "Form filled"

    values = {f["name"]: f["value"] for f in _form(api, form_doc["id"])["fields"]}
    assert values["full_name"] == "Ada Lovelace"


def test_fill_with_flatten_removes_the_widgets(api, form_doc):
    job = _op(api, form_doc["id"], "fill_form",
              {"values": {"full_name": "Grace"}, "flatten_after": True})
    assert job["status"] == "succeeded", job
    assert api.get(
        f"/api/documents/{form_doc['id']}/versions/"
    ).json()[0]["label"] == "Form filled and flattened"
    assert _form(api, form_doc["id"])["has_form"] is False


def test_an_unknown_field_name_fails_the_job_and_names_it(api, form_doc):
    job = _op(api, form_doc["id"], "fill_form", {"values": {"nope": "x"}})
    assert job["status"] == "failed"
    assert job["error_code"] == "validation_error"
    assert "nope" in job["error_message"]


def test_a_guest_fills_a_form_end_to_end(guest, guest_form_doc):
    job = _op(guest, guest_form_doc["id"], "fill_form",
              {"values": {"full_name": "Guest User", "agree": True}})
    assert job["status"] == "succeeded", job
    values = {f["name"]: f["value"]
              for f in _form(guest, guest_form_doc["id"])["fields"]}
    assert values["full_name"] == "Guest User"


def test_saved_values_are_in_the_downloaded_file(api, form_doc):
    """"Saved values visible in external viewers" — asserted on the bytes that
    leave the API, read back through PyMuPDF's widget layer."""
    _op(api, form_doc["id"], "fill_form", {"values": {"full_name": "Ada"}})
    blob = b"".join(api.get(
        f"/api/documents/{form_doc['id']}/download/"
    ).streaming_content)
    doc = fitz.open(stream=blob, filetype="pdf")
    try:
        values = {w.field_name: w.field_value for page in doc for w in page.widgets()}
    finally:
        doc.close()
    assert values["full_name"] == "Ada"


# --------------------------------------------------------------------------- #
# Field builder
# --------------------------------------------------------------------------- #
def test_build_six_field_types_on_a_blank_document(api, fixture_bytes):
    doc = _upload(api, "blank.pdf", fixture_bytes("text.pdf"))
    rect = lambda y: {"x": 0.1, "y": y, "w": 0.4, "h": 0.03}  # noqa: E731
    job = _op(api, doc["id"], "edit_form_fields_batch", {"ops": [
        {"action": "add", "field": {"name": "who", "type": "text", "page": 0,
                                    "rect": rect(0.10)}},
        {"action": "add", "field": {"name": "agree", "type": "checkbox", "page": 0,
                                    "rect": rect(0.20)}},
        {"action": "add", "field": {"name": "plan", "type": "radio", "page": 0,
                                    "options": ["basic", "pro"],
                                    "rects": [rect(0.30), rect(0.35)]}},
        {"action": "add", "field": {"name": "size", "type": "combobox", "page": 0,
                                    "rect": rect(0.45), "options": ["s", "m"]}},
        {"action": "add", "field": {"name": "colour", "type": "listbox", "page": 0,
                                    "rect": rect(0.55), "options": ["red", "blue"]}},
        {"action": "add", "field": {"name": "sign_here", "type": "signature",
                                    "page": 0, "rect": rect(0.65)}},
    ]})
    assert job["status"] == "succeeded", job
    assert job["result"]["report"]["added"] == 6

    body = _form(api, doc["id"])
    kinds = {f["name"]: f["type"] for f in body["fields"]}
    assert kinds == {"who": "text", "agree": "checkbox", "plan": "radio",
                     "size": "combobox", "colour": "listbox",
                     "sign_here": "signature"}


def test_the_whole_builder_session_is_one_job(api, fixture_bytes):
    doc = _upload(api, "blank.pdf", fixture_bytes("text.pdf"))
    before = len(api.get(f"/api/documents/{doc['id']}/versions/").json())
    _op(api, doc["id"], "edit_form_fields_batch", {"ops": [
        {"action": "add", "field": {"name": f"f{i}", "type": "text", "page": 0,
                                    "rect": {"x": 0.1, "y": 0.05 * (i + 1),
                                             "w": 0.4, "h": 0.03}}}
        for i in range(5)
    ]})
    after = api.get(f"/api/documents/{doc['id']}/versions/").json()
    assert len(after) == before + 1, "five fields must be one version, not five"
    assert after[0]["label"] == "Form edited (5 field(s))"


def test_a_duplicate_field_name_fails_the_job(api, form_doc):
    job = _op(api, form_doc["id"], "edit_form_fields_batch", {"ops": [
        {"action": "add", "field": {"name": "full_name", "type": "text", "page": 0,
                                    "rect": {"x": 0.1, "y": 0.5, "w": 0.4, "h": 0.03}}},
    ]})
    assert job["status"] == "failed"
    assert "unique" in job["error_message"]


def test_a_guest_builds_a_form(guest, guest_doc):
    job = _op(guest, guest_doc["id"], "edit_form_fields_batch", {"ops": [
        {"action": "add", "field": {"name": "guest_field", "type": "text",
                                    "page": 0,
                                    "rect": {"x": 0.1, "y": 0.5, "w": 0.4, "h": 0.03}}},
    ]})
    assert job["status"] == "succeeded", job
    assert _form(guest, guest_doc["id"])["fields"][0]["name"] == "guest_field"


# --------------------------------------------------------------------------- #
# Import / export
# --------------------------------------------------------------------------- #
def test_export_json_is_an_attachment(api, form_doc):
    _op(api, form_doc["id"], "fill_form", {"values": {"full_name": "Ada"}})
    resp = api.get(f"/api/documents/{form_doc['id']}/form/export/?format=json")
    assert resp.status_code == 200
    assert resp["Content-Type"] == "application/json"
    assert "attachment" in resp["Content-Disposition"]
    assert json.loads(resp.content)["full_name"] == "Ada"


def test_export_csv(api, form_doc):
    _op(api, form_doc["id"], "fill_form", {"values": {"full_name": "Grace"}})
    resp = api.get(f"/api/documents/{form_doc['id']}/form/export/?format=csv")
    assert resp["Content-Type"] == "text/csv"
    assert b"full_name,Grace" in resp.content


def test_export_rejects_an_unknown_format(api, form_doc):
    resp = api.get(f"/api/documents/{form_doc['id']}/form/export/?format=xml")
    assert resp.status_code == 400


def test_import_round_trip_through_the_api(api, form_doc):
    """Acceptance: export JSON → clear → import → identical values."""
    _op(api, form_doc["id"], "fill_form",
        {"values": {"full_name": "Ada Lovelace", "agree": True}})
    exported = api.get(
        f"/api/documents/{form_doc['id']}/form/export/?format=json"
    ).content.decode()
    before = {f["name"]: f["value"] for f in _form(api, form_doc["id"])["fields"]}

    cleared = _op(api, form_doc["id"], "fill_form",
                  {"values": {"full_name": "", "agree": False}}, base_seq=2)
    assert cleared["status"] == "succeeded", cleared
    assert {f["name"]: f["value"]
            for f in _form(api, form_doc["id"])["fields"]}["full_name"] == ""

    restored = _op(api, form_doc["id"], "import_form_data",
                   {"format": "json", "data": exported}, base_seq=3)
    assert restored["status"] == "succeeded", restored
    assert {f["name"]: f["value"] for f in _form(api, form_doc["id"])["fields"]} == before


def test_import_csv(api, form_doc):
    job = _op(api, form_doc["id"], "import_form_data",
              {"format": "csv", "data": "name,value\nfull_name,Katherine\n"})
    assert job["status"] == "succeeded", job
    values = {f["name"]: f["value"] for f in _form(api, form_doc["id"])["fields"]}
    assert values["full_name"] == "Katherine"


def test_import_rejects_a_file_with_no_values(api, form_doc):
    job = _op(api, form_doc["id"], "import_form_data",
              {"format": "json", "data": "{}"})
    assert job["status"] == "failed"


def test_import_rejects_broken_json(api, form_doc):
    job = _op(api, form_doc["id"], "import_form_data",
              {"format": "json", "data": "{not json"})
    assert job["status"] == "failed"
    assert job["error_code"] == "validation_error"


# --------------------------------------------------------------------------- #
# Validation before a job exists
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("type_,params", [
    ("fill_form", {"values": {}}),
    ("fill_form", {}),
    ("edit_form_fields_batch", {"ops": []}),
    ("edit_form_fields_batch", {"ops": [{"action": "add", "field": {}}]}),
    ("edit_form_fields_batch", {"ops": [{"action": "mangle",
                                         "field": {"name": "x"}}]}),
    ("import_form_data", {"format": "xml", "data": "{}"}),
    ("import_form_data", {"format": "json"}),
])
def test_malformed_params_are_rejected_before_a_job_exists(api, form_doc,
                                                           type_, params):
    from apps.jobs.models import Job

    resp = api.post(f"/api/documents/{form_doc['id']}/operations/",
                    {"type": type_, "params": params}, format="json")
    assert resp.status_code == 400, resp.content
    assert Job.objects.count() == 0
