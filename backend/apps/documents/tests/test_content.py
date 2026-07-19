import pytest

from apps.pdf_engine.storage import get_storage

pytestmark = pytest.mark.django_db


def test_full_content_stream(api, uploaded_doc):
    doc_id = uploaded_doc["id"]
    r = api.get(f"/api/documents/{doc_id}/content/")
    assert r.status_code == 200
    assert r.headers["Accept-Ranges"] == "bytes"
    assert r.headers["Content-Type"] == "application/pdf"
    body = b"".join(r.streaming_content)
    assert body[:5] == b"%PDF-"
    assert int(r.headers["Content-Length"]) == len(body)


def test_range_request_206(api, uploaded_doc):
    doc_id = uploaded_doc["id"]
    r = api.get(f"/api/documents/{doc_id}/content/", HTTP_RANGE="bytes=0-99")
    assert r.status_code == 206
    assert r.headers["Content-Range"].startswith("bytes 0-99/")
    body = b"".join(r.streaming_content)
    assert len(body) == 100


def test_conditional_304(api, uploaded_doc):
    doc_id = uploaded_doc["id"]
    etag = f'"{uploaded_doc["current_version"] and ""}"'
    # fetch etag from a HEAD-ish GET
    r = api.get(f"/api/documents/{doc_id}/content/")
    etag = r.headers["ETag"]
    r2 = api.get(f"/api/documents/{doc_id}/content/", HTTP_IF_NONE_MATCH=etag)
    assert r2.status_code == 304


def test_invalid_range_416(api, uploaded_doc):
    doc_id = uploaded_doc["id"]
    r = api.get(f"/api/documents/{doc_id}/content/", HTTP_RANGE="bytes=99999999-")
    assert r.status_code == 416


def test_thumbnail_render_and_cache(api, uploaded_doc):
    doc_id = uploaded_doc["id"]
    seq = uploaded_doc["current_version"]["seq"]
    r = api.get(f"/api/documents/{doc_id}/pages/0/thumbnail/?w=240")
    assert r.status_code == 200
    assert r.headers["Content-Type"] == "image/png"
    # cached to storage → second call hits the cache key
    assert get_storage().exists(f"thumbs/{doc_id}/{seq}/p0@240.png")
    r2 = api.get(f"/api/documents/{doc_id}/pages/0/thumbnail/?w=240")
    assert r2.status_code == 200


def test_thumbnail_out_of_range(api, uploaded_doc):
    doc_id = uploaded_doc["id"]
    r = api.get(f"/api/documents/{doc_id}/pages/99/thumbnail/")
    assert r.status_code == 404


def test_download_attachment(api, uploaded_doc):
    doc_id = uploaded_doc["id"]
    r = api.get(f"/api/documents/{doc_id}/download/")
    assert r.status_code == 200
    assert "attachment" in r.headers["Content-Disposition"]


def test_outline_and_search(api, uploaded_doc):
    doc_id = uploaded_doc["id"]
    r = api.get(f"/api/documents/{doc_id}/outline/")
    assert r.status_code == 200
    assert "outline" in r.json()
    r = api.get(f"/api/documents/{doc_id}/text-search/?q=ZenPDF")
    assert r.status_code == 200
    assert len(r.json()["hits"]) == 3
