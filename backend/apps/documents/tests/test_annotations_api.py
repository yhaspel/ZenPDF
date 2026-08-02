"""Phase-3 API surface: annotations read model, `annotate_batch`, `flatten`,
the overlay's text layer, and ephemeral image assets.

Guest parity is asserted alongside every account path — §20 DoD item 9 makes a
tool that only works logged in an incomplete phase.
"""
import io

import fitz
import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

pytestmark = pytest.mark.django_db


HIGHLIGHT = {
    "id": "h-1", "page": 0, "type": "highlight",
    "quads": [{"x": 0.1, "y": 0.1, "w": 0.3, "h": 0.02}],
    "color": "#ffff00", "contents": "note to self",
}


def _op(client, doc_id, type_, params, base_seq=1):
    resp = client.post(
        f"/api/documents/{doc_id}/operations/",
        {"type": type_, "params": params, "base_version_seq": base_seq},
        format="json",
    )
    assert resp.status_code == 202, resp.content
    return client.get(f"/api/jobs/{resp.json()['id']}/").json()


def _annotate(client, doc_id, ops, base_seq=1):
    return _op(client, doc_id, "annotate_batch", {"ops": ops}, base_seq)


def _png(rgb=(255, 0, 0), size=(60, 40)) -> bytes:
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, *size))
    pix.set_rect(pix.irect, rgb)
    return pix.tobytes("png")


def _upload_image(client, data=None, name="stamp.png", content_type="image/png"):
    upload = SimpleUploadedFile(name, data if data is not None else _png(),
                                content_type=content_type)
    return client.post("/api/uploads/image/", {"file": upload}, format="multipart")


# --------------------------------------------------------------------------- #
# Read model
# --------------------------------------------------------------------------- #
def test_annotations_endpoint_is_empty_for_a_fresh_document(api, uploaded_doc):
    resp = api.get(f"/api/documents/{uploaded_doc['id']}/annotations/")
    assert resp.status_code == 200
    assert resp.json() == {"version": 1, "annotations": []}


def test_annotate_batch_creates_a_labeled_version_and_shows_up(api, uploaded_doc):
    job = _annotate(api, uploaded_doc["id"], [{"action": "add", "annotation": HIGHLIGHT}])
    assert job["status"] == "succeeded", job
    assert job["result"]["seq"] == 2
    assert job["result"]["report"]["added"] == 1

    # Versions list newest-first (`DocumentVersion.Meta.ordering = ["-seq"]`).
    versions = api.get(f"/api/documents/{uploaded_doc['id']}/versions/").json()["results"]
    assert versions[0]["seq"] == 2
    assert versions[0]["label"] == "Annotated (1 change(s))"

    items = api.get(f"/api/documents/{uploaded_doc['id']}/annotations/").json()["annotations"]
    assert [a["id"] for a in items] == ["h-1"]
    assert items[0]["contents"] == "note to self"


def test_annotations_can_be_read_at_an_older_version(api, uploaded_doc):
    _annotate(api, uploaded_doc["id"], [{"action": "add", "annotation": HIGHLIGHT}])
    at_v1 = api.get(f"/api/documents/{uploaded_doc['id']}/annotations/?version=1").json()
    assert at_v1 == {"version": 1, "annotations": []}


def test_annotations_can_be_filtered_by_page(api, uploaded_doc):
    _annotate(api, uploaded_doc["id"], [
        {"action": "add", "annotation": HIGHLIGHT},
        {"action": "add", "annotation": {**HIGHLIGHT, "id": "h-2", "page": 2}},
    ])
    page2 = api.get(
        f"/api/documents/{uploaded_doc['id']}/annotations/?page=2"
    ).json()["annotations"]
    assert [a["id"] for a in page2] == ["h-2"]


# --------------------------------------------------------------------------- #
# Authorship (phase-03 §3)
# --------------------------------------------------------------------------- #
def test_author_is_the_display_name_for_an_account(api, uploaded_doc):
    _annotate(api, uploaded_doc["id"], [{"action": "add", "annotation": HIGHLIGHT}])
    items = api.get(f"/api/documents/{uploaded_doc['id']}/annotations/").json()["annotations"]
    assert items[0]["author"] == "Alice"


def test_author_is_guest_for_a_guest_and_leaks_no_session_id(guest, guest_doc):
    job = _annotate(guest, guest_doc["id"], [{"action": "add", "annotation": HIGHLIGHT}])
    assert job["status"] == "succeeded", job
    items = guest.get(f"/api/documents/{guest_doc['id']}/annotations/").json()["annotations"]
    assert items[0]["author"] == "Guest"

    blob = b"".join(guest.get(f"/api/documents/{guest_doc['id']}/download/").streaming_content)
    assert guest.token.encode() not in blob


# --------------------------------------------------------------------------- #
# Guest parity — the whole tool works with no account (§20 DoD 9)
# --------------------------------------------------------------------------- #
def test_a_guest_annotates_and_flattens_end_to_end(guest, guest_doc):
    doc_id = guest_doc["id"]
    job = _annotate(guest, doc_id, [
        {"action": "add", "annotation": HIGHLIGHT},
        {"action": "add", "annotation": {"id": "n-1", "page": 0, "type": "note",
                                         "rect": {"x": 0.5, "y": 0.5, "w": 0.03, "h": 0.03},
                                         "contents": "guest note"}},
    ])
    assert job["status"] == "succeeded", job
    assert len(guest.get(f"/api/documents/{doc_id}/annotations/").json()["annotations"]) == 2

    flat = _op(guest, doc_id, "flatten", {"what": "annotations"}, base_seq=2)
    assert flat["status"] == "succeeded", flat
    assert guest.get(f"/api/documents/{doc_id}/annotations/").json()["annotations"] == []
    versions = guest.get(f"/api/documents/{doc_id}/versions/").json()["results"]
    assert versions[0]["seq"] == 3
    assert versions[0]["label"] == "Flattened annotations"


def test_flatten_keeps_the_marks_visible(api, uploaded_doc):
    _annotate(api, uploaded_doc["id"], [
        {"action": "add", "annotation": {**HIGHLIGHT, "color": "#ff0000", "opacity": 1.0}},
    ])
    _op(api, uploaded_doc["id"], "flatten", {"what": "annotations"}, base_seq=2)
    blob = b"".join(api.get(f"/api/documents/{uploaded_doc['id']}/content/").streaming_content)
    doc = fitz.open(stream=blob, filetype="pdf")
    try:
        page = doc[0]
        rect = page.rect
        pm = page.get_pixmap(clip=fitz.Rect(0.12 * rect.width, 0.11 * rect.height,
                                            0.35 * rect.width, 0.125 * rect.height))
        colors = {pm.pixel(x, y) for y in range(0, pm.height, 3)
                  for x in range(0, pm.width, 3)}
    finally:
        doc.close()
    assert any(c[0] > 200 and c[1] < 120 for c in colors), colors


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "params",
    [
        {"ops": []},
        {"ops": [{"action": "obliterate", "annotation": HIGHLIGHT}]},
        {"ops": [{"action": "add", "annotation": {**HIGHLIGHT, "type": "hologram"}}]},
        {"ops": [{"action": "add", "annotation": {k: v for k, v in HIGHLIGHT.items()
                                                  if k != "quads"}}]},
        {"ops": [{"action": "add", "annotation": {**HIGHLIGHT, "color": "red"}}]},
        {"ops": [{"action": "add", "annotation": {**HIGHLIGHT, "opacity": 5}}]},
        {"ops": [{"action": "add", "annotation": {**HIGHLIGHT, "page": -1}}]},
        {"ops": [{"action": "add", "annotation": {**HIGHLIGHT, "surprise": 1}}]},
    ],
)
def test_malformed_ops_are_rejected_before_a_job_exists(api, uploaded_doc, params):
    from apps.jobs.models import Job

    resp = api.post(f"/api/documents/{uploaded_doc['id']}/operations/",
                    {"type": "annotate_batch", "params": params}, format="json")
    assert resp.status_code == 400, resp.content
    assert resp.json()["error"]["code"] == "validation_error"
    assert Job.objects.count() == 0


def test_flatten_rejects_an_unknown_target(api, uploaded_doc):
    resp = api.post(f"/api/documents/{uploaded_doc['id']}/operations/",
                    {"type": "flatten", "params": {"what": "everything"}}, format="json")
    assert resp.status_code == 400


def test_annotate_batch_honours_the_base_version_guard(api, uploaded_doc):
    job = _annotate(api, uploaded_doc["id"],
                    [{"action": "add", "annotation": HIGHLIGHT}], base_seq=99)
    assert job["status"] == "failed"
    assert job["error_code"] == "version_conflict"


# --------------------------------------------------------------------------- #
# The overlay's text layer
# --------------------------------------------------------------------------- #
def test_text_words_returns_normalized_word_rects(api, uploaded_doc):
    body = api.get(f"/api/documents/{uploaded_doc['id']}/text-words/?page=0").json()
    assert body["page"] == 0
    assert body["has_text"] is True
    assert body["words"][0]["t"] == "Sample"
    assert all(0 <= w["x"] <= 1 for w in body["words"])


def test_text_words_out_of_range_is_a_validation_error(api, uploaded_doc):
    resp = api.get(f"/api/documents/{uploaded_doc['id']}/text-words/?page=99")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "validation_error"


def test_guest_can_read_the_text_layer(guest, guest_doc):
    body = guest.get(f"/api/documents/{guest_doc['id']}/text-words/?page=0").json()
    assert body["has_text"] is True


# --------------------------------------------------------------------------- #
# Ephemeral image assets (§13 `uploads/…`)
# --------------------------------------------------------------------------- #
def test_a_guest_can_upload_a_stamp_image(guest):
    resp = _upload_image(guest)
    assert resp.status_code == 201, resp.content
    body = resp.json()
    assert body["width"] == 60 and body["height"] == 40
    assert body["content_type"] == "image/png"
    assert guest.token, "uploading is a write, so it mints a session (§21.2)"


def test_image_upload_rejects_a_non_image(api):
    resp = _upload_image(api, data=b"%PDF-1.7 not an image", name="x.png")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "validation_error"


def test_image_upload_requires_a_file(api):
    assert api.post("/api/uploads/image/", {}, format="multipart").status_code == 400


def test_image_upload_enforces_the_tier_size_cap(guest):
    from django.test import override_settings

    from apps.documents.tests.test_ingest import tiers_with

    with override_settings(TIERS=tiers_with("guest", max_image_upload_mb=0)):
        resp = _upload_image(guest)
    assert resp.status_code == 413
    assert resp.json()["error"]["code"] == "file_too_large"


def test_an_uploaded_image_can_be_stamped_by_its_owner(api, uploaded_doc):
    ref = _upload_image(api).json()["ref"]
    job = _annotate(api, uploaded_doc["id"], [
        {"action": "add", "annotation": {
            "id": "img-1", "page": 0, "type": "image_stamp",
            "rect": {"x": 0.6, "y": 0.2, "w": 0.25, "h": 0.1}, "image_ref": ref}},
    ])
    assert job["status"] == "succeeded", job
    items = api.get(f"/api/documents/{uploaded_doc['id']}/annotations/").json()["annotations"]
    assert items[0]["type"] == "image_stamp"
    assert items[0]["image_ref"] == ref


def test_one_principal_cannot_stamp_another_principals_image(api, other_api,
                                                             uploaded_doc, fixture_bytes):
    """The storage key is derived from the *caller's* principal, so a stolen ref
    resolves to nothing — the job fails validation rather than reading someone
    else's asset (§13, `core.assets`)."""
    stolen = _upload_image(other_api).json()["ref"]
    job = _annotate(api, uploaded_doc["id"], [
        {"action": "add", "annotation": {
            "id": "img-x", "page": 0, "type": "image_stamp",
            "rect": {"x": 0.6, "y": 0.2, "w": 0.25, "h": 0.1}, "image_ref": stolen}},
    ])
    assert job["status"] == "failed"
    assert job["error_code"] == "validation_error"
    assert stolen in job["error_message"]


def test_guest_purge_removes_uploaded_images(guest, fixture_bytes):
    from datetime import timedelta

    from django.utils import timezone

    from apps.core.assets import principal_prefix
    from apps.core.models import GuestSession
    from apps.core.tasks import guest_purge
    from apps.pdf_engine.storage import get_storage

    assert _upload_image(guest).status_code == 201
    session = GuestSession.resolve(guest.token)
    prefix = principal_prefix(session)
    assert get_storage().list_prefix(prefix), "asset should exist before expiry"

    GuestSession.objects.filter(pk=session.pk).update(
        expires_at=timezone.now() - timedelta(hours=1)
    )
    guest_purge()
    assert get_storage().list_prefix(prefix) == []


def test_uploaded_image_is_reencoded_so_exif_cannot_travel(api, user):
    """Re-encoding strips EXIF — which can carry GPS coordinates the user never
    meant to paste into a document they are about to share."""
    from apps.core.assets import asset_key
    from apps.pdf_engine.storage import get_storage

    marker = b"SECRETGPSMARKER"
    jpeg = _jpeg_with_comment(marker)
    ref = _upload_image(api, data=jpeg, name="p.jpg", content_type="image/jpeg").json()["ref"]
    stored = get_storage().get_bytes(asset_key(user, ref))
    assert marker not in stored
    assert stored[:8] == b"\x89PNG\r\n\x1a\n"


def _jpeg_with_comment(marker: bytes) -> bytes:
    """A minimal JPEG carrying `marker` in a COM segment."""
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 40, 30))
    pix.set_rect(pix.irect, (10, 200, 10))
    jpeg = pix.tobytes("jpeg")
    com = b"\xff\xfe" + (len(marker) + 2).to_bytes(2, "big") + marker
    return jpeg[:2] + com + jpeg[2:]


def test_image_ref_cannot_escape_its_prefix(api):
    from apps.core.assets import ImageRejected, asset_key

    with pytest.raises(ImageRejected):
        asset_key(object(), "../../docs/other")


def test_annotations_survive_a_download_and_reopen(api, uploaded_doc):
    """Acceptance: annotations must be visible in an external viewer — proven
    mechanically by reading the *downloaded* bytes back with a second library."""
    import pypdf

    _annotate(api, uploaded_doc["id"], [{"action": "add", "annotation": HIGHLIGHT}])
    blob = b"".join(api.get(f"/api/documents/{uploaded_doc['id']}/download/").streaming_content)
    reader = pypdf.PdfReader(io.BytesIO(blob))
    annots = reader.pages[0].get("/Annots", []) or []
    subtypes = [(a.get_object() or {}).get("/Subtype") for a in annots]
    assert "/Highlight" in subtypes


# --------------------------------------------------------------------------- #
# Image-asset hardening (found by the security lens of the phase-3 self-review)
# --------------------------------------------------------------------------- #
def _png_bomb(width: int, height: int) -> bytes:
    """A tiny PNG that *decodes* to width×height. All-zero scanlines compress to
    almost nothing, which is exactly what makes it a bomb: the byte cap sees a
    small file and the pixel cap — if it runs after the decode — sees a dead
    process."""
    import struct
    import zlib

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload)) + tag + payload
                + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)  # 8-bit greyscale
    # Compress row by row: materializing the raw scanlines would allocate the
    # very gigabytes this test exists to prove we never allocate.
    compressor = zlib.compressobj(9)
    row = b"\x00" + b"\x00" * width
    parts = [compressor.compress(row) for _ in range(height)]
    parts.append(compressor.flush())
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", b"".join(parts)) + chunk(b"IEND", b""))


def test_a_decompression_bomb_is_refused_from_its_header(api):
    """40000x40000 = 1.6 Gpx ≈ 2.9 GB decoded, from ~1.5 MB of input — inside
    every byte cap. It must be refused *before* anything is allocated, because
    this runs in the API process where §12's worker memory limits do not apply
    and the OOM killer leaves no exception to catch."""
    from apps.core.assets import ImageRejected, header_dimensions, normalize_png

    bomb = _png_bomb(40000, 40000)
    assert len(bomb) < 5 * 1024 * 1024
    assert header_dimensions(bomb) == (40000, 40000)
    with pytest.raises(ImageRejected):
        normalize_png(bomb, max_bytes=5 * 1024 * 1024)

    resp = _upload_image(api, data=bomb, name="bomb.png")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "validation_error"


def test_header_dimensions_reads_png_and_jpeg_without_decoding():
    from apps.core.assets import header_dimensions

    assert header_dimensions(_png_bomb(1234, 567)) == (1234, 567)
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 80, 40))
    pix.set_rect(pix.irect, (1, 2, 3))
    assert header_dimensions(pix.tobytes("jpeg")) == (80, 40)
    assert header_dimensions(b"not an image at all") is None


def test_stored_images_are_metered_against_the_storage_quota(guest):
    """Normalization re-encodes to lossless PNG, which is routinely several times
    larger than the JPEG that arrived — an unmetered namespace would let a small
    upload become storage nothing ever accounted for."""
    from apps.core.models import GuestSession

    assert _upload_image(guest).status_code == 201
    session = GuestSession.resolve(guest.token)
    assert session.storage_bytes_used > 0


def test_image_upload_refuses_when_it_would_exceed_the_quota(guest):
    from django.test import override_settings

    from apps.documents.tests.test_ingest import tiers_with

    with override_settings(TIERS=tiers_with("guest", storage_mb=0)):
        resp = _upload_image(guest)
    assert resp.status_code == 429
    assert resp.json()["error"]["code"] == "quota_exceeded"


def test_image_upload_keeps_the_guest_throttles(api):
    """The scoped rate is *added* to the defaults. Replacing them would silently
    drop the per-token and per-IP guest limits on a guest-reachable write."""
    from apps.core.throttling import GuestIPThrottle, GuestThrottle
    from apps.core.views import ImageUploadView

    classes = {type(t) for t in ImageUploadView().get_throttles()}
    assert GuestThrottle in classes
    assert GuestIPThrottle in classes


def test_claiming_a_session_carries_its_uploaded_images(guest, user):
    """`uploads/…` is the one namespace keyed by principal, so a metadata-only
    reparent misses it — and the session is expired by the claim, so the next
    `guest_purge` would delete the bytes within the hour."""
    from apps.core.assets import principal_prefix
    from apps.core.claim import claim_session
    from apps.core.models import GuestSession
    from apps.core.tasks import guest_purge
    from apps.pdf_engine.storage import get_storage

    ref = _upload_image(guest).json()["ref"]
    session = GuestSession.resolve(guest.token)
    assert get_storage().list_prefix(principal_prefix(session))

    summary = claim_session(session, user)
    assert summary["assets"] == 1
    assert get_storage().list_prefix(principal_prefix(session)) == []
    assert get_storage().exists(f"{principal_prefix(user)}{ref}.png")

    # And the purge that follows the claim cannot take them away.
    guest_purge()
    assert get_storage().exists(f"{principal_prefix(user)}{ref}.png")


def test_the_overlay_raster_excludes_annotations(api, uploaded_doc):
    """The overlay draws every annotation itself as editable SVG, so its page
    raster must not already contain them — otherwise each one renders twice and
    the baked copy does not move when the editable one is dragged."""
    _annotate(api, uploaded_doc["id"], [
        {"action": "add", "annotation": {**HIGHLIGHT, "color": "#ff0000", "opacity": 1.0}},
    ])
    base = f"/api/documents/{uploaded_doc['id']}/pages/0/thumbnail/?w=600"

    def red_pixels(url: str) -> int:
        png = api.get(url).content
        pix = fitz.Pixmap(png)
        return sum(
            1
            for y in range(0, pix.height, 2)
            for x in range(0, pix.width, 2)
            if pix.pixel(x, y)[0] > 200 and pix.pixel(x, y)[1] < 120
        )

    assert red_pixels(base) > 0, "the default raster still shows annotations"
    assert red_pixels(f"{base}&annots=false") == 0


def test_an_extracted_annotation_can_be_sent_straight_back_as_an_update(api, uploaded_doc):
    """The edit round-trip, end to end.

    The client edits an annotation by patching the object the server gave it, so
    every field extraction produces must also validate on the way in. `null`
    colours are the case that broke: `GET /annotations/` reports an unset fill
    as `null`, and a string-only schema rejected it — failing the entire batch
    the first time anyone edited a saved comment.
    """
    _annotate(api, uploaded_doc["id"], [{"action": "add", "annotation": HIGHLIGHT}])
    loaded = api.get(
        f"/api/documents/{uploaded_doc['id']}/annotations/"
    ).json()["annotations"][0]
    assert loaded["fill"] is None, "this test is only meaningful while fill is unset"

    job = _annotate(
        api, uploaded_doc["id"],
        [{"action": "update", "annotation": {**loaded, "contents": "edited"}}],
        base_seq=2,
    )
    assert job["status"] == "succeeded", job
    again = api.get(
        f"/api/documents/{uploaded_doc['id']}/annotations/"
    ).json()["annotations"]
    assert len(again) == 1
    assert again[0]["contents"] == "edited"


@pytest.mark.parametrize("kind", ["highlight", "square", "ink", "arrow", "note", "stamp"])
def test_every_extracted_type_revalidates_on_the_way_back_in(api, uploaded_doc, kind):
    """Same contract as above, across the shapes that carry different fields."""
    specs = {
        "highlight": HIGHLIGHT,
        "square": {"id": "s", "page": 0, "type": "square",
                   "rect": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.1}, "color": "#ff0000"},
        "ink": {"id": "i", "page": 0, "type": "ink",
                "ink": [[[0.2, 0.5], [0.25, 0.52], [0.3, 0.5]]], "color": "#006600"},
        "arrow": {"id": "a", "page": 0, "type": "arrow",
                  "vertices": [[0.1, 0.9], [0.5, 0.92]], "color": "#000000"},
        "note": {"id": "n", "page": 0, "type": "note",
                 "rect": {"x": 0.5, "y": 0.5, "w": 0.03, "h": 0.03}, "contents": "hi"},
        "stamp": {"id": "t", "page": 0, "type": "stamp",
                  "rect": {"x": 0.6, "y": 0.1, "w": 0.3, "h": 0.06},
                  "stamp_name": "Approved"},
    }
    _annotate(api, uploaded_doc["id"], [{"action": "add", "annotation": specs[kind]}])
    loaded = api.get(
        f"/api/documents/{uploaded_doc['id']}/annotations/"
    ).json()["annotations"][0]

    resp = api.post(
        f"/api/documents/{uploaded_doc['id']}/operations/",
        {"type": "annotate_batch", "params": {"ops": [{"action": "update", "annotation": loaded}]},
         "base_version_seq": 2},
        format="json",
    )
    assert resp.status_code == 202, resp.content
    job = api.get(f"/api/jobs/{resp.json()['id']}/").json()
    assert job["status"] == "succeeded", job
