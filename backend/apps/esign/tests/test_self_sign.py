"""Self-signing (phase-08 §8A) — the guest half of the access split.

The Phase-2B gate lives here: a visitor with no account draws a signature,
places it, and gets a signed document. Nothing is saved, nothing is emailed,
and no login appears anywhere in the path (§21.3).
"""
import base64

import fitz
import pytest

from apps.pdf_engine.engine import signatures as SG
from apps.pdf_engine.exceptions import InvalidParams

pytestmark = pytest.mark.django_db


def _ink(width=300, height=120) -> bytes:
    """A drawn signature as the canvas produces it: ink on transparency."""
    doc = fitz.open()
    page = doc.new_page(width=width, height=height)
    page.draw_line((40, 80), (260, 50), width=3)
    data = page.get_pixmap(alpha=True).tobytes("png")
    doc.close()
    return data


def _upload_signature(client) -> str:
    from django.core.files.uploadedfile import SimpleUploadedFile

    resp = client.post("/api/uploads/image/",
                       {"file": SimpleUploadedFile("sig.png", _ink(),
                                                   content_type="image/png")},
                       format="multipart")
    assert resp.status_code == 201, resp.content
    return resp.json()["ref"]


def _text_of(client, doc_id) -> bytes:
    return b"".join(client.get(f"/api/documents/{doc_id}/content/").streaming_content)


# --------------------------------------------------------------------------- #
# The engine
# --------------------------------------------------------------------------- #
def test_a_typed_signature_renders_in_each_vendored_font():
    for font in SG.TYPED_FONTS:
        png = SG.render_typed("Ada Lovelace", font)
        pixmap = fitz.Pixmap(png)
        assert pixmap.width > 50 and pixmap.height > 20, font
        assert pixmap.alpha, f"{font} rendered on an opaque background"


def test_an_unknown_font_is_named_rather_than_guessed():
    with pytest.raises(InvalidParams, match="Unknown signature font"):
        SG.render_typed("Ada", "comic-sans")


def test_typing_nothing_is_refused():
    with pytest.raises(InvalidParams, match="Type your name"):
        SG.render_typed("   ", "caveat")


def test_a_drawn_signature_is_trimmed_to_the_ink():
    """Without this the *canvas* is scaled into the box and the ink ends up a
    quarter of the size the person drew, floating in the middle of it."""
    raw = _ink(400, 200)
    trimmed = SG.trim_transparent(raw)

    before, after = fitz.Pixmap(raw), fitz.Pixmap(trimmed)
    assert after.width < before.width and after.height < before.height
    assert after.width > 100, "the trim ate the signature"


def test_an_empty_canvas_is_refused():
    doc = fitz.open()
    doc.new_page(width=200, height=100)
    blank = doc[0].get_pixmap(alpha=True).tobytes("png")
    doc.close()
    with pytest.raises(InvalidParams, match="empty"):
        SG.trim_transparent(blank)


def test_a_photograph_of_paper_comes_back_on_transparency():
    doc = fitz.open()
    page = doc.new_page(width=300, height=120)
    page.draw_rect(fitz.Rect(0, 0, 300, 120), color=(0.94, 0.93, 0.9),
                   fill=(0.94, 0.93, 0.9))
    page.insert_text((30, 70), "Ada", fontsize=40)
    photo = page.get_pixmap().tobytes("png")
    doc.close()

    out = fitz.Pixmap(SG.remove_background(photo))
    assert out.alpha, "the paper is still there"


def test_placing_a_signature_flattens_it_into_the_page():
    """A signature that can be dragged off the page afterwards is a picture."""
    doc = fitz.open()
    doc.new_page(width=595, height=842)
    data = doc.tobytes()
    doc.close()

    out = SG.self_sign(
        data,
        placements=[{"signature_upload_ref": "sig", "page": 0,
                     "rect": {"x": 0.1, "y": 0.8, "w": 0.3, "h": 0.06}}],
        images={"sig": _ink()},
    )
    signed = fitz.open(stream=out, filetype="pdf")
    try:
        assert not list(signed[0].annots()), "the signature is an annotation"
        assert signed[0].get_images(), "nothing was drawn"
    finally:
        signed.close()


def test_a_placement_naming_a_signature_we_do_not_have_is_refused():
    doc = fitz.open()
    doc.new_page()
    data = doc.tobytes()
    doc.close()
    with pytest.raises(InvalidParams, match="was not found"):
        SG.self_sign(data, placements=[{"signature_id": "nope", "page": 0,
                                        "rect": {"x": 0, "y": 0, "w": 0.1,
                                                 "h": 0.1}}], images={})


def test_a_page_out_of_range_is_refused():
    doc = fitz.open()
    doc.new_page()
    data = doc.tobytes()
    doc.close()
    with pytest.raises(InvalidParams, match="out of range"):
        SG.self_sign(data, placements=[{"signature_upload_ref": "s", "page": 4,
                                        "rect": {"x": 0, "y": 0, "w": 0.1,
                                                 "h": 0.1}}],
                     images={"s": _ink()})


# --------------------------------------------------------------------------- #
# Through the API — the Phase-2B gate
# --------------------------------------------------------------------------- #
def test_a_guest_signs_a_document_with_no_account(guest, guest_doc):
    """**Phase-2B acceptance criterion**, carried into Phase 8: `self_sign` via
    `signature_upload_ref` works end to end with no account."""
    ref = _upload_signature(guest)
    resp = guest.post(f"/api/documents/{guest_doc['id']}/operations/",
                      {"type": "self_sign",
                       "params": {"placements": [{"signature_upload_ref": ref,
                                                  "page": 0,
                                                  "rect": {"x": 0.1, "y": 0.8,
                                                           "w": 0.3, "h": 0.06}}],
                                  "include_date": True},
                       "base_version_seq": 1}, format="json")
    assert resp.status_code == 202, resp.content
    job = guest.get(f"/api/jobs/{resp.json()['id']}/").json()
    assert job["status"] == "succeeded", job

    versions = guest.get(f"/api/documents/{guest_doc['id']}/versions/").json()["results"]
    assert versions[0]["label"] == "Signed (self)"

    signed = fitz.open(stream=_text_of(guest, guest_doc["id"]), filetype="pdf")
    try:
        assert signed[0].get_images(), "the signature never reached the page"
        assert "Signed" in signed[0].get_text(), "the date was not stamped"
    finally:
        signed.close()


def test_a_guest_asking_for_a_saved_signature_is_told_to_make_an_account(
        guest, guest_doc):
    """Not a 404 dressed up: a guest has no library, and saying so is what
    turns this into a signup prompt rather than a dead end (§21.3)."""
    resp = guest.post(f"/api/documents/{guest_doc['id']}/operations/",
                      {"type": "self_sign",
                       "params": {"placements": [
                           {"signature_id": "00000000-0000-0000-0000-000000000000",
                            "page": 0,
                            "rect": {"x": 0.1, "y": 0.8, "w": 0.3, "h": 0.06}}]},
                       "base_version_seq": 1}, format="json")
    assert resp.status_code == 202
    job = guest.get(f"/api/jobs/{resp.json()['id']}/").json()
    assert job["status"] == "failed"
    assert job["error_code"] == "account_required"
    assert "free account" in job["error_message"]


def test_an_account_signs_with_a_saved_signature(api, uploaded_doc):
    created = api.post("/api/signatures/",
                       {"method": "type", "kind": "signature",
                        "text": "Ada Lovelace", "font": "caveat",
                        "is_default": True}, format="json")
    assert created.status_code == 201, created.content
    signature = created.json()

    resp = api.post(f"/api/documents/{uploaded_doc['id']}/operations/",
                    {"type": "self_sign",
                     "params": {"placements": [{"signature_id": signature["id"],
                                                "page": 0,
                                                "rect": {"x": 0.1, "y": 0.8,
                                                         "w": 0.3, "h": 0.06}}]},
                     "base_version_seq": 1}, format="json")
    assert resp.status_code == 202, resp.content
    assert api.get(f"/api/jobs/{resp.json()['id']}/").json()["status"] == "succeeded"


def test_a_saved_signature_belongs_to_one_account(api, other_api):
    created = api.post("/api/signatures/",
                       {"method": "type", "text": "Ada", "font": "caveat"},
                       format="json").json()
    assert other_api.get(f"/api/signatures/{created['id']}/").status_code == 404
    assert other_api.get(f"/api/signatures/{created['id']}/image/").status_code == 404


def test_a_drawn_signature_is_stored_trimmed(api):
    image = "data:image/png;base64," + base64.b64encode(_ink(400, 200)).decode()
    created = api.post("/api/signatures/",
                       {"method": "draw", "image": image}, format="json")
    assert created.status_code == 201, created.content

    png = api.get(f"/api/signatures/{created.json()['id']}/image/")
    assert png.status_code == 200
    assert fitz.Pixmap(png.content).width < 400, "the canvas was stored untrimmed"


def test_only_one_default_per_kind(api):
    first = api.post("/api/signatures/", {"method": "type", "text": "A",
                                          "font": "caveat", "is_default": True},
                     format="json").json()
    api.post("/api/signatures/", {"method": "type", "text": "B",
                                  "font": "caveat", "is_default": True},
             format="json")

    rows = {row["id"]: row for row in api.get("/api/signatures/").json()}
    assert rows[first["id"]]["is_default"] is False
    assert sum(row["is_default"] for row in rows.values()) == 1


def test_a_signature_lands_where_it_was_put_on_a_rotated_page(fixture_bytes):
    """§8's rule, and the one only a rendered-pixel assertion catches.

    `insert_image` writes in the page's **unrotated** space while the rect
    arrives in display space, so without de-rotation a signature placed at the
    displayed top-left of a landscape page lands off the right-hand edge — or
    off the page entirely.
    """
    data = fixture_bytes("rotated-90.pdf")
    out = SG.self_sign(
        data,
        placements=[{"signature_upload_ref": "sig", "page": 0,
                     "rect": {"x": 0.05, "y": 0.05, "w": 0.30, "h": 0.10}}],
        images={"sig": _ink()},
    )
    doc = fitz.open(stream=out, filetype="pdf")
    try:
        page = doc[0]
        # `get_image_bbox` answers in display space — where the user pointed.
        box = page.get_image_bbox(page.get_images(full=True)[0])
        assert page.rotation == 90, "the fixture stopped being rotated"

        # Inside the box that was drawn, allowing for `keep_proportion`.
        assert 42 <= box.x0 <= 295 and 42 <= box.x1 <= 295, box
        assert abs(box.y0 - 0.05 * page.rect.height) < 2, box
        assert abs(box.y1 - 0.15 * page.rect.height) < 2, box
        # …and not lying on its side. This catches a *quarter* turn, which
        # changes the box's proportions. It cannot catch a **half** turn —
        # 180° is a symmetry of a bounding box, so this assertion passed for
        # months on upside-down output. That is what the rendered-pixel test
        # below is for; keep both, they catch different things.
        assert box.width > box.height, f"the signature is sideways: {box}"
    finally:
        doc.close()


def _asymmetric_ink(width=300, height=120) -> bytes:
    """A signature with an unmistakable top: a bar across the top quarter.

    Deliberately not symmetric under any rotation, because the defect this
    guards against is a 180° flip and every symmetric mark is blind to it.
    """
    doc = fitz.open()
    page = doc.new_page(width=width, height=height)
    page.draw_rect(fitz.Rect(0, 0, width, height * 0.25),
                   color=None, fill=(1, 0, 0))
    page.draw_line((40, height * 0.7), (260, height * 0.6), width=3)
    data = page.get_pixmap(alpha=True).tobytes("png")
    doc.close()
    return data


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_a_signature_is_upright_at_every_page_rotation(rotation):
    """The half-turn the bounding-box assertion above cannot see.

    §8's product law is that placed content reads upright **to the reader**
    whatever the page's `/Rotate`. Proving that needs the one PyMuPDF API which
    applies the rotation — `get_pixmap` — because every other lens is blind to
    it: a round-trip cancels the error out, a bounding box is symmetric under
    it, and `get_text` returns the same glyphs whichever way up they are.

    0 and 180 are in the parametrize as controls, not padding: the old formula
    and the correct one **agree** at exactly those two, so a test that omitted
    them could not distinguish "fixed" from "broken in the other direction".
    """
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.set_rotation(rotation)
    source = doc.tobytes()
    doc.close()

    out = SG.self_sign(
        source,
        placements=[{"signature_upload_ref": "sig", "page": 0,
                     "rect": {"x": 0.10, "y": 0.50, "w": 0.40, "h": 0.10}}],
        images={"sig": _asymmetric_ink()},
    )

    doc = fitz.open(stream=out, filetype="pdf")
    try:
        page = doc[0]
        pixmap = page.get_pixmap(dpi=72)  # the reader's view: rotation applied
        red = [(x, y)
               for y in range(pixmap.height)
               for x in range(pixmap.width)
               if _is_red(pixmap, x, y)]
        assert red, "the signature did not render at all"
        centre_y = sum(y for _, y in red) / len(red) / pixmap.height
        # The placed box spans 0.50–0.60 of the displayed height and the bar is
        # in its top quarter, so upright puts the red near 0.51 and a half turn
        # puts it near 0.59. Asserting against the middle of the box separates
        # them with room to spare either side.
        assert centre_y < 0.55, (
            f"the signature is upside down at /Rotate {rotation}: "
            f"red centroid at y={centre_y:.3f}, expected the top of the box"
        )
    finally:
        doc.close()


def _is_red(pixmap, x, y) -> bool:
    pixel = pixmap.pixel(x, y)
    return pixel[0] > 180 and pixel[1] < 90 and pixel[2] < 90
