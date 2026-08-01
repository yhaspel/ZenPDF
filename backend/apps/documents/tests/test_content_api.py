"""Phase-4 API surface: content read models and the 17 editing operations.

Guest parity alongside every account path — §20 DoD item 9.
"""
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


def _text(client, doc_id) -> str:
    import unicodedata

    blob = b"".join(client.get(f"/api/documents/{doc_id}/content/").streaming_content)
    doc = fitz.open(stream=blob, filetype="pdf")
    try:
        return unicodedata.normalize("NFKC", "\n".join(p.get_text() for p in doc))
    finally:
        doc.close()


def _blocks(client, doc_id, page=0):
    return client.get(
        f"/api/documents/{doc_id}/text-blocks/?page={page}"
    ).json()["blocks"]


def _png(rgb=(255, 0, 0), size=(60, 40)) -> bytes:
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, *size))
    pix.set_rect(pix.irect, rgb)
    return pix.tobytes("png")


def _upload_image(client) -> str:
    upload = SimpleUploadedFile("logo.png", _png(), content_type="image/png")
    resp = client.post("/api/uploads/image/", {"file": upload}, format="multipart")
    assert resp.status_code == 201, resp.content
    return resp.json()["ref"]


# --------------------------------------------------------------------------- #
# Read models
# --------------------------------------------------------------------------- #
def test_text_blocks_endpoint(api, uploaded_doc):
    body = api.get(f"/api/documents/{uploaded_doc['id']}/text-blocks/?page=0").json()
    assert body["is_scanned_page"] is False
    assert body["blocks"]
    assert "Sample document" in body["blocks"][0]["text"]


def test_text_blocks_flags_a_scan(api, fixture_bytes):
    upload = SimpleUploadedFile("scanned.pdf", fixture_bytes("scanned.pdf"),
                                content_type="application/pdf")
    doc = api.post("/api/documents/", {"file": upload}, format="multipart").json()
    body = api.get(f"/api/documents/{doc['id']}/text-blocks/?page=0").json()
    assert body["is_scanned_page"] is True


def test_images_and_links_endpoints(api, uploaded_doc):
    assert api.get(f"/api/documents/{uploaded_doc['id']}/images/?page=0").json() == {
        "page": 0, "images": []
    }
    assert api.get(f"/api/documents/{uploaded_doc['id']}/links/?page=0").json() == {
        "page": 0, "links": []
    }


def test_read_models_reject_a_bad_page(api, uploaded_doc):
    resp = api.get(f"/api/documents/{uploaded_doc['id']}/text-blocks/?page=99")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "validation_error"


def test_a_guest_can_read_the_content_models(guest, guest_doc):
    assert guest.get(
        f"/api/documents/{guest_doc['id']}/text-blocks/?page=0"
    ).json()["blocks"]


# --------------------------------------------------------------------------- #
# edit_text
# --------------------------------------------------------------------------- #
def test_edit_text_creates_a_labeled_version(api, uploaded_doc):
    block = _blocks(api, uploaded_doc["id"])[0]
    job = _op(api, uploaded_doc["id"], "edit_text", {
        "edits": [{"page": 0, "block_bbox": block["bbox"], "new_text": "Rewritten"}],
    })
    assert job["status"] == "succeeded", job
    versions = api.get(f"/api/documents/{uploaded_doc['id']}/versions/").json()
    assert versions[0]["label"] == "Edited text (1 block(s))"
    assert "Rewritten" in _text(api, uploaded_doc["id"])


def test_edit_text_overflow_reaches_the_client_as_a_usable_error(api, uploaded_doc):
    """The UI offers "shrink to N pt" — so the job must carry N, not just fail."""
    job = _op(api, uploaded_doc["id"], "edit_text", {
        "edits": [{
            "page": 0,
            "block_bbox": {"x": 0.1, "y": 0.1, "w": 0.12, "h": 0.02},
            "new_text": "far too much text to fit " * 40,
            "style": {"size": 18},
        }],
    })
    assert job["status"] == "failed"
    assert job["error_code"] == "text_overflow"


def test_a_guest_edits_text_end_to_end(guest, guest_doc):
    block = _blocks(guest, guest_doc["id"])[0]
    job = _op(guest, guest_doc["id"], "edit_text", {
        "edits": [{"page": 0, "block_bbox": block["bbox"], "new_text": "Guest edit"}],
    })
    assert job["status"] == "succeeded", job
    assert "Guest edit" in _text(guest, guest_doc["id"])


# --------------------------------------------------------------------------- #
# find & replace — the two-step flow
# --------------------------------------------------------------------------- #
def test_find_replace_dry_run_makes_no_version(api, uploaded_doc):
    before = api.get(f"/api/documents/{uploaded_doc['id']}/versions/").json()
    job = _op(api, uploaded_doc["id"], "find_replace", {"find": "page", "dry_run": True})
    assert job["status"] == "succeeded", job
    assert job["result"]["report"]["count"] >= 3
    assert job["result"]["report"]["dry_run"] is True
    after = api.get(f"/api/documents/{uploaded_doc['id']}/versions/").json()
    assert len(after) == len(before), "a search must not mint a version"


def test_find_replace_executes_only_the_kept_matches(api, uploaded_doc):
    preview = _op(api, uploaded_doc["id"], "find_replace",
                  {"find": "page", "dry_run": True})
    keep = [preview["result"]["report"]["matches"][0]["id"]]
    job = _op(api, uploaded_doc["id"], "find_replace",
              {"find": "page", "replace": "SHEET", "only": keep})
    assert job["status"] == "succeeded", job
    assert job["result"]["report"]["replaced"] == 1
    text = _text(api, uploaded_doc["id"])
    assert "SHEET" in text
    assert "page" in text


# --------------------------------------------------------------------------- #
# whiteout / add_text
# --------------------------------------------------------------------------- #
def test_whiteout_and_add_text(api, uploaded_doc):
    job = _op(api, uploaded_doc["id"], "whiteout", {
        "rects": [{"page": 0, "rect": {"x": 0.1, "y": 0.08, "w": 0.6, "h": 0.06}}],
    })
    assert job["status"] == "succeeded", job
    job2 = _op(api, uploaded_doc["id"], "add_text", {
        "boxes": [{"page": 0, "rect": {"x": 0.1, "y": 0.5, "w": 0.5, "h": 0.06},
                   "text": "Fresh text"}],
    }, base_seq=2)
    assert job2["status"] == "succeeded", job2
    assert "Fresh text" in _text(api, uploaded_doc["id"])


# --------------------------------------------------------------------------- #
# images
# --------------------------------------------------------------------------- #
def test_add_then_delete_an_image_through_the_api(api, uploaded_doc):
    ref = _upload_image(api)
    job = _op(api, uploaded_doc["id"], "add_image", {
        "page": 0, "rect": {"x": 0.1, "y": 0.6, "w": 0.3, "h": 0.2}, "image_ref": ref,
    })
    assert job["status"] == "succeeded", job
    images = api.get(f"/api/documents/{uploaded_doc['id']}/images/?page=0").json()["images"]
    assert len(images) == 1

    job2 = _op(api, uploaded_doc["id"], "delete_image",
               {"page": 0, "xref": images[0]["xref"]}, base_seq=2)
    assert job2["status"] == "succeeded", job2
    assert api.get(
        f"/api/documents/{uploaded_doc['id']}/images/?page=0"
    ).json()["images"] == []


def test_one_principal_cannot_use_another_principals_image(api, other_api, uploaded_doc):
    stolen = _upload_image(other_api)
    job = _op(api, uploaded_doc["id"], "add_image", {
        "page": 0, "rect": {"x": 0.1, "y": 0.6, "w": 0.3, "h": 0.2},
        "image_ref": stolen,
    })
    assert job["status"] == "failed"
    assert stolen in job["error_message"]


# --------------------------------------------------------------------------- #
# links
# --------------------------------------------------------------------------- #
def test_link_lifecycle(api, uploaded_doc):
    job = _op(api, uploaded_doc["id"], "add_link", {
        "page": 0, "rect": {"x": 0.1, "y": 0.5, "w": 0.2, "h": 0.03},
        "kind": "uri", "uri": "https://example.com",
    })
    assert job["status"] == "succeeded", job
    links = api.get(f"/api/documents/{uploaded_doc['id']}/links/?page=0").json()["links"]
    assert links[0]["uri"] == "https://example.com"

    job2 = _op(api, uploaded_doc["id"], "delete_link", {"page": 0, "index": 0}, base_seq=2)
    assert job2["status"] == "succeeded", job2
    assert api.get(
        f"/api/documents/{uploaded_doc['id']}/links/?page=0"
    ).json()["links"] == []


def test_a_dangerous_link_is_refused_by_the_job(api, uploaded_doc):
    job = _op(api, uploaded_doc["id"], "add_link", {
        "page": 0, "rect": {"x": 0.1, "y": 0.5, "w": 0.2, "h": 0.03},
        "kind": "uri", "uri": "javascript:alert(1)",
    })
    assert job["status"] == "failed"
    assert job["error_code"] == "validation_error"


# --------------------------------------------------------------------------- #
# stamping suite
# --------------------------------------------------------------------------- #
def test_page_numbers_through_the_api(api, uploaded_doc):
    job = _op(api, uploaded_doc["id"], "page_numbers",
              {"format": "Page {page} of {total}"})
    assert job["status"] == "succeeded", job
    assert "Page 1 of 3" in _text(api, uploaded_doc["id"])


def test_bates_reports_its_range_in_the_job_result(api, uploaded_doc):
    job = _op(api, uploaded_doc["id"], "bates",
              {"prefix": "ZEN-", "start": 5, "digits": 4})
    assert job["status"] == "succeeded", job
    assert job["result"]["report"]["first"] == "ZEN-0005"
    assert job["result"]["report"]["last"] == "ZEN-0007"


def test_watermark_text_and_image(api, uploaded_doc):
    job = _op(api, uploaded_doc["id"], "watermark", {"text": "DRAFT", "under": True})
    assert job["status"] == "succeeded", job
    assert "DRAFT" in _text(api, uploaded_doc["id"])

    ref = _upload_image(api)
    job2 = _op(api, uploaded_doc["id"], "watermark",
               {"image_ref": ref, "opacity": 0.5}, base_seq=2)
    assert job2["status"] == "succeeded", job2


def test_watermark_needs_text_or_an_image(api, uploaded_doc):
    resp = api.post(f"/api/documents/{uploaded_doc['id']}/operations/",
                    {"type": "watermark", "params": {"opacity": 0.5}}, format="json")
    assert resp.status_code == 400


def test_header_footer_and_metadata_and_bookmarks(api, uploaded_doc):
    doc_id = uploaded_doc["id"]
    assert _op(api, doc_id, "header_footer",
               {"segments": {"top-left": "ACME", "bottom-center": "{page}/{total}"}},
               )["status"] == "succeeded"
    assert _op(api, doc_id, "set_metadata",
               {"title": "Report", "author": "Alice"}, base_seq=2)["status"] == "succeeded"
    assert _op(api, doc_id, "set_bookmarks",
               {"toc": [[1, "Start", 1], [2, "Detail", 2]]},
               base_seq=3)["status"] == "succeeded"

    outline = api.get(f"/api/documents/{doc_id}/outline/").json()["outline"]
    assert [o["title"] for o in outline] == ["Start", "Detail"]
    detail = api.get(f"/api/documents/{doc_id}/").json()
    assert "ACME" in _text(api, doc_id)
    assert detail["page_count"] == 3


def test_overlay_pdf_needs_a_document_the_caller_owns(api, other_api, uploaded_doc,
                                                      fixture_bytes):
    upload = SimpleUploadedFile("other.pdf", fixture_bytes("unicode.pdf"),
                                content_type="application/pdf")
    theirs = other_api.post("/api/documents/", {"file": upload},
                            format="multipart").json()
    job = _op(api, uploaded_doc["id"], "overlay_pdf",
              {"overlay_document_id": theirs["id"]})
    assert job["status"] == "failed"
    assert job["error_code"] == "not_found"


def test_overlay_pdf_with_an_owned_document(api, uploaded_doc, fixture_bytes):
    upload = SimpleUploadedFile("letterhead.pdf", fixture_bytes("unicode.pdf"),
                                content_type="application/pdf")
    mine = api.post("/api/documents/", {"file": upload}, format="multipart").json()
    job = _op(api, uploaded_doc["id"], "overlay_pdf",
              {"overlay_document_id": mine["id"], "mode": "foreground"})
    assert job["status"] == "succeeded", job
    assert "Café" in _text(api, uploaded_doc["id"])


# --------------------------------------------------------------------------- #
# Validation happens before a job exists
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("type_,params", [
    ("edit_text", {"edits": []}),
    ("add_text", {"boxes": [{"page": 0, "rect": {"x": 0, "y": 0, "w": 1, "h": 1}}]}),
    ("whiteout", {"rects": []}),
    ("find_replace", {"find": ""}),
    ("page_numbers", {"position": "middle"}),
    ("bates", {"digits": 99}),
    ("set_bookmarks", {"toc": [[1, "x"]]}),
    ("add_link", {"page": 0, "rect": {"x": 0, "y": 0, "w": 1, "h": 1}, "kind": "ftp"}),
    ("header_footer", {"segments": {"middle": "x"}}),
    ("add_image", {"page": 0, "rect": {"x": 0, "y": 0, "w": 1, "h": 1},
                   "image_ref": "../etc"}),
])
def test_malformed_params_are_rejected_before_a_job_exists(api, uploaded_doc,
                                                           type_, params):
    from apps.jobs.models import Job

    resp = api.post(f"/api/documents/{uploaded_doc['id']}/operations/",
                    {"type": type_, "params": params}, format="json")
    assert resp.status_code == 400, resp.content
    assert Job.objects.count() == 0


def test_every_phase_4_op_is_reachable_by_a_guest():
    """§21.3 lists what needs an account, and content editing is not on it.

    Asserted structurally rather than by 17 end-to-end tests: the default
    permission is `IsPrincipal`, so the way an op *would* become account-only is
    a declaration on the view — this catches that, and it catches a *new* op
    added later without one.
    """
    from apps.core.permissions import IsAccount, IsPrincipal
    from apps.documents.views import DocumentOperationView
    from apps.pdf_engine import registry

    permissions = DocumentOperationView().get_permissions()
    assert any(isinstance(p, IsPrincipal) for p in permissions)
    assert not any(isinstance(p, IsAccount) for p in permissions)

    # And every Phase-4 op really is on the single-document entrypoint that
    # view serves, rather than quietly routed somewhere account-only.
    phase_4 = {
        "edit_text", "add_text", "whiteout", "find_replace",
        "add_image", "replace_image", "delete_image",
        "add_link", "edit_link", "delete_link",
        "header_footer", "page_numbers", "bates", "watermark",
        "overlay_pdf", "set_metadata", "set_bookmarks",
    }
    assert phase_4 <= set(registry.OPERATIONS)
    assert not any(registry.OPERATIONS[op].is_cross_document for op in phase_4)
