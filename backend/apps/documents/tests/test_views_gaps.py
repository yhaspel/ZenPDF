"""`apps.documents.views` — the edges the happy-path suites step around.

Each of these is a branch a reader of the view would assume is there and a
regression would silently remove: a `?page=abc` that falls back to page 0
rather than a 500, an engine refusal that reaches the client as a 400 with the
engine's own sentence, a `Range` header in a form the parser must call invalid,
the two upload refusals that happen before any byte is read, the presigned
redirect, and the folder cascade walking a tree without looping.
"""
from unittest.mock import patch

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

from apps.documents import views
from apps.documents.models import Document, Folder
from apps.documents.views import _parse_range
from apps.pdf_engine.exceptions import EngineError
from apps.pdf_engine.storage import get_storage

pytestmark = pytest.mark.django_db


def _boom(*_args, **_kwargs):
    raise EngineError("the engine said no", code="validation_error")


# --------------------------------------------------------------------------- #
# Range header parsing
# --------------------------------------------------------------------------- #
def test_a_missing_or_non_bytes_range_means_no_range():
    assert _parse_range("", 100) is None
    assert _parse_range("items=0-5", 100) is None


def test_a_range_without_a_dash_is_invalid():
    assert _parse_range("bytes=5", 100) == "invalid"


def test_a_range_with_non_numeric_bounds_is_invalid():
    assert _parse_range("bytes=a-b", 100) == "invalid"
    assert _parse_range("bytes=-xyz", 100) == "invalid"
    assert _parse_range("bytes=0-x", 100) == "invalid"


def test_a_suffix_range_takes_the_last_n_bytes():
    assert _parse_range("bytes=-10", 100) == (90, 99)
    # Asking for more than the file holds clamps to the whole file.
    assert _parse_range("bytes=-500", 100) == (0, 99)


def test_an_open_ended_range_runs_to_the_end_and_is_clamped():
    assert _parse_range("bytes=40-", 100) == (40, 99)
    assert _parse_range("bytes=40-9999", 100) == (40, 99)


def test_a_backwards_or_out_of_bounds_range_is_invalid():
    assert _parse_range("bytes=50-10", 100) == "invalid"
    assert _parse_range("bytes=100-", 100) == "invalid"


def test_only_the_first_range_of_a_multi_range_is_honoured():
    assert _parse_range("bytes=0-9, 20-29", 100) == (0, 9)


def test_a_suffix_range_streams_the_tail_of_the_document(api, uploaded_doc):
    resp = api.get(f"/api/documents/{uploaded_doc['id']}/content/", HTTP_RANGE="bytes=-16")
    assert resp.status_code == 206
    body = b"".join(resp.streaming_content)
    assert len(body) == 16
    assert b"%%EOF" in body
    size = int(resp["Content-Range"].rsplit("/", 1)[1])
    assert resp["Content-Range"] == f"bytes {size - 16}-{size - 1}/{size}"


def test_a_malformed_range_answers_416_with_the_size(api, uploaded_doc):
    resp = api.get(f"/api/documents/{uploaded_doc['id']}/content/", HTTP_RANGE="bytes=abc-")
    assert resp.status_code == 416
    assert resp["Content-Range"].startswith("bytes */")


def test_a_download_ignores_the_range_header(api, uploaded_doc):
    resp = api.get(f"/api/documents/{uploaded_doc['id']}/download/", HTTP_RANGE="bytes=0-9")
    assert resp.status_code == 200
    assert "Content-Range" not in resp


# --------------------------------------------------------------------------- #
# Upload refusals
# --------------------------------------------------------------------------- #
def test_an_upload_without_a_file_field_is_refused(api):
    resp = api.post("/api/documents/", {"title": "x"}, format="multipart")
    assert resp.status_code == 400
    assert "No file was uploaded" in resp.json()["error"]["message"]


def test_a_guest_cannot_upload_when_guest_access_is_disabled(settings, anon, fixture_bytes):
    """The permission layer closes the door first (401, `IsPrincipal`), so a
    visitor never sees the view's own guard — but the row count is the thing
    that matters: nothing is minted and nothing is stored."""
    settings.GUEST_ACCESS_ENABLED = False
    upload = SimpleUploadedFile("text.pdf", fixture_bytes("text.pdf"),
                                content_type="application/pdf")
    resp = anon.post("/api/documents/", {"file": upload}, format="multipart")
    assert resp.status_code == 401
    assert Document.objects.count() == 0
    assert "X-Guest-Token" not in resp


def test_the_upload_view_refuses_when_no_principal_can_be_minted(api, fixture_bytes):
    """The view's own guard, for the case where the permission layer let the
    request through but minting answered None: a 400 that says why, not an
    AttributeError on `None.plan`."""
    upload = SimpleUploadedFile("text.pdf", fixture_bytes("text.pdf"),
                                content_type="application/pdf")
    with patch.object(views, "require_principal", return_value=None):
        resp = api.post("/api/documents/", {"file": upload}, format="multipart")
    assert resp.status_code == 400
    assert "Guest access is disabled" in resp.json()["error"]["message"]
    assert Document.objects.count() == 0


# --------------------------------------------------------------------------- #
# Content delivery: presigned redirect and the "no content" guard
# --------------------------------------------------------------------------- #
def test_presigned_delivery_redirects_to_storage(settings, api, uploaded_doc):
    settings.PRESIGNED_DELIVERY = True
    storage = get_storage()
    with patch.object(storage, "presigned_get",
                      return_value="https://bucket.invalid/signed?x=1") as presigned:
        resp = api.get(f"/api/documents/{uploaded_doc['id']}/content/")
    assert resp.status_code == 302
    assert resp["Location"] == "https://bucket.invalid/signed?x=1"
    presigned.assert_called_once()


def test_presigned_delivery_falls_back_to_streaming_when_unsupported(settings, api, uploaded_doc):
    """The filesystem backend cannot presign; the flag must not break it."""
    settings.PRESIGNED_DELIVERY = True
    resp = api.get(f"/api/documents/{uploaded_doc['id']}/content/")
    assert resp.status_code == 200
    assert b"".join(resp.streaming_content).startswith(b"%PDF-")


def test_a_document_with_no_version_yet_has_no_content(api, uploaded_doc):
    Document.objects.filter(id=uploaded_doc["id"]).update(current_version=None)
    resp = api.get(f"/api/documents/{uploaded_doc['id']}/content/")
    assert resp.status_code == 400
    assert "no content yet" in resp.json()["error"]["message"]


# --------------------------------------------------------------------------- #
# Query-param fallbacks
# --------------------------------------------------------------------------- #
def test_a_non_numeric_thumbnail_width_falls_back_to_240(api, uploaded_doc):
    resp = api.get(f"/api/documents/{uploaded_doc['id']}/pages/0/thumbnail/?w=wide")
    assert resp.status_code == 200
    seq = uploaded_doc["current_version"]["seq"]
    assert get_storage().exists(f"thumbs/{uploaded_doc['id']}/{seq}/p0@240.png")


def test_a_non_numeric_page_falls_back_to_page_zero_for_text_words(api, uploaded_doc):
    resp = api.get(f"/api/documents/{uploaded_doc['id']}/text-words/?page=first")
    assert resp.status_code == 200
    assert resp.json()["page"] == 0
    assert resp.json()["words"]


def test_a_non_numeric_page_falls_back_to_page_zero_for_read_models(api, uploaded_doc):
    resp = api.get(f"/api/documents/{uploaded_doc['id']}/text-blocks/?page=first")
    assert resp.status_code == 200
    assert resp.json()["blocks"]


def test_a_non_numeric_page_means_every_page_for_annotations(api, uploaded_doc):
    with patch.object(views.engine_annotations, "extract_annotations",
                      return_value=[]) as extract:
        resp = api.get(f"/api/documents/{uploaded_doc['id']}/annotations/?page=all")
    assert resp.status_code == 200
    assert extract.call_args.kwargs["pages"] is None


def test_a_non_numeric_page_means_every_page_for_search(api, uploaded_doc):
    with patch.object(views, "search_text", return_value=[]) as search:
        resp = api.get(f"/api/documents/{uploaded_doc['id']}/text-search/?q=x&page=all")
    assert resp.status_code == 200
    assert search.call_args.args[2] is None


def test_an_empty_search_query_returns_no_hits_without_opening_the_file(api, uploaded_doc):
    with patch.object(views, "search_text") as search:
        resp = api.get(f"/api/documents/{uploaded_doc['id']}/text-search/?q=%20")
    assert resp.status_code == 200
    assert resp.json() == {"query": "", "hits": []}
    search.assert_not_called()


# --------------------------------------------------------------------------- #
# EngineError → 400 with the engine's sentence
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("target, path", [
    ("engine_render.render_thumbnail", "pages/0/thumbnail/?w=333"),
    ("inspect_pdf", "outline/"),
    ("engine_annotations.extract_annotations", "annotations/"),
    ("engine_text.page_words", "text-words/"),
    ("engine_content.text_blocks", "text-blocks/"),
    ("engine_forms.read_form", "form/"),
    ("engine_forms.export_form_data", "form/export/"),
    ("search_text", "text-search/?q=x"),
])
def test_an_engine_refusal_reaches_the_client_as_a_validation_error(
        api, uploaded_doc, target, path):
    with patch(f"apps.documents.views.{target}", side_effect=_boom):
        resp = api.get(f"/api/documents/{uploaded_doc['id']}/{path}")
    assert resp.status_code == 400, resp.content
    body = resp.json()["error"]
    assert body["code"] == "validation_error"
    assert body["message"] == "the engine said no"


def test_a_bad_export_format_is_a_400_from_the_engine(api, uploaded_doc):
    resp = api.get(f"/api/documents/{uploaded_doc['id']}/form/export/?format=xml")
    assert resp.status_code == 400
    assert "json" in resp.json()["error"]["message"]


def test_a_cross_document_op_with_bad_params_is_refused_before_a_job(api):
    from apps.jobs.models import Job

    resp = api.post("/api/operations/",
                    {"type": "merge", "params": {"document_ids": "not-a-list"}},
                    format="json")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "validation_error"
    assert Job.objects.count() == 0


def test_a_cross_document_op_on_an_encrypted_source_is_refused(api, fixture_bytes):
    from apps.jobs.models import Job

    ids = []
    for name in ("text.pdf", "encrypted.pdf"):
        upload = SimpleUploadedFile(name, fixture_bytes(name), content_type="application/pdf")
        resp = api.post("/api/documents/", {"file": upload}, format="multipart")
        assert resp.status_code == 201, resp.content
        ids.append(resp.json()["id"])
    assert Document.objects.get(id=ids[1]).is_encrypted

    resp = api.post("/api/operations/",
                    {"type": "merge", "params": {"document_ids": ids}}, format="json")
    assert resp.status_code == 423
    assert Job.objects.count() == 0


# --------------------------------------------------------------------------- #
# Folder cascade
# --------------------------------------------------------------------------- #
def test_cascade_trashes_documents_in_every_descendant_folder(api, user, fixture_bytes):
    root = api.post("/api/folders/", {"name": "Root"}, format="json").json()["id"]
    child = api.post("/api/folders/", {"name": "Child", "parent": root},
                     format="json").json()["id"]
    grandchild = api.post("/api/folders/", {"name": "Grandchild", "parent": child},
                          format="json").json()["id"]
    for folder in (root, grandchild):
        upload = SimpleUploadedFile("text.pdf", fixture_bytes("text.pdf"),
                                    content_type="application/pdf")
        api.post("/api/documents/", {"file": upload, "folder": folder}, format="multipart")

    resp = api.delete(f"/api/folders/{root}/?cascade=trash")
    assert resp.status_code == 204
    assert not Folder.objects.filter(id__in=[root, child, grandchild]).exists()
    assert api.get("/api/documents/").json()["count"] == 0
    assert api.get("/api/documents/?trashed=true").json()["count"] == 2


def test_cascade_survives_a_cyclic_folder_graph(api, user):
    """The API refuses to build a cycle; a corrupted row must still not hang
    the delete."""
    a = Folder.objects.create(owner=user, name="A")
    b = Folder.objects.create(owner=user, name="B", parent=a)
    Folder.objects.filter(pk=a.pk).update(parent=b)

    resp = api.delete(f"/api/folders/{a.id}/?cascade=trash")
    assert resp.status_code == 204
    assert not Folder.objects.filter(pk__in=[a.pk, b.pk]).exists()
