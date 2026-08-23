"""Signature images and self-signing (phase-08; §8, §10).

Three ways to make a signature, one way to place it:

* **draw** — the browser's canvas arrives as a PNG with alpha; we trim the
  transparent margin so the placed image is the ink and nothing else.
* **type** — a name rendered in one of four cursive faces, vendored in the repo
  rather than fetched from Google at runtime: a signing ceremony that pulls a
  font from a third party leaks who is signing what, to them.
* **upload** — a photograph of a signature on paper. The paper is removed by
  luminance threshold, which is crude and says so in the UI: a dark scan comes
  back as a dark blob, and the fix is to draw instead.

Placement is `insert_image` at §8 coordinates and then a **flatten**: a signed
document must not have a moveable signature on it.
"""
from __future__ import annotations

import io
import os

import fitz

from ..exceptions import EngineError, InvalidParams
from ..geometry import (
    NormRect,
    apply_matrix_rect,
    content_rotation,
    norm_to_page_rect,
)

# Vendored so the ceremony makes no third-party request (see module docstring).
FONT_DIR = os.path.join(os.path.dirname(__file__), "..", "fonts")
TYPED_FONTS = {
    "caveat": "Caveat-Regular.ttf",
    "dancing": "DancingScript-Regular.ttf",
    "great-vibes": "GreatVibes-Regular.ttf",
    "sacramento": "Sacramento-Regular.ttf",
}

MAX_PLACEMENTS = 100
# The envelope footer, in points. Absolute rather than a fraction of the page:
# see `stamp_envelope_footer`.
FOOTER_SIZE = 7.0
FOOTER_BAND = 20.0
FOOTER_MARGIN = 10.0
# A signature image is small by nature; this is a decompression ceiling, not a
# quality one.
MAX_SIGNATURE_PIXELS = 8_000_000


def _open_image(data: bytes) -> fitz.Pixmap:
    """Decode an accepted image, refusing a decompression bomb on its header.

    The pixel ceiling used to be checked on the `Pixmap`, which is checking
    after the damage: `fitz.Pixmap(data)` allocates the full bitmap, so a 1.5 MB
    PNG declaring 40000×40000 is ~2.9 GB claimed inside the API process before
    anyone counts. On Linux the OOM killer takes the process and there is no
    exception left to catch. `assets.header_dimensions` reads the size out of
    the IHDR/SOFn without decoding — the same guard the image-asset path has
    used since phase 3, which this path was simply missing.
    """
    # Function-local: `apps.core` imports the engine, so a module-level import
    # here would close the cycle.
    from apps.core.assets import header_dimensions

    dims = header_dimensions(data)
    if dims is None:
        raise InvalidParams("That image could not be read.")
    if dims[0] * dims[1] > MAX_SIGNATURE_PIXELS:
        raise InvalidParams("That image is too large to use as a signature.")

    try:
        pixmap = fitz.Pixmap(data)
    except Exception as exc:  # noqa: BLE001
        raise InvalidParams(f"That image could not be read: {exc}") from exc
    # Kept as well as the header check: the header is a claim, and a file whose
    # real dimensions exceed what it declared must not slip through either.
    if pixmap.width * pixmap.height > MAX_SIGNATURE_PIXELS:
        raise InvalidParams("That image is too large to use as a signature.")
    return pixmap


def trim_transparent(data: bytes, *, padding: int = 4) -> bytes:
    """Crop the empty margin off a drawn signature.

    A canvas is mostly nothing. Without this, placing the PNG in a box scales
    the *canvas* into the box and the ink ends up a quarter of the size the
    person drew, floating in the middle of it.
    """
    pixmap = _open_image(data)
    if not pixmap.alpha:
        return data

    width, height, n = pixmap.width, pixmap.height, pixmap.n
    stride, samples = pixmap.stride, pixmap.samples
    min_x, min_y, max_x, max_y = width, height, -1, -1
    for y in range(height):
        # One slice per row rather than a Python loop per pixel: a canvas is
        # ~1000×400, and the per-pixel version was measurably slow enough to be
        # felt in the signing dialog.
        row = samples[y * stride: y * stride + width * n]
        alpha = row[n - 1::n]
        if max(alpha) <= 8:
            continue
        first = next(i for i, a in enumerate(alpha) if a > 8)
        last = width - 1 - next(i for i, a in enumerate(reversed(alpha)) if a > 8)
        min_x, max_x = min(min_x, first), max(max_x, last)
        min_y, max_y = min(min_y, y), max(max_y, y)
    if max_x < 0:
        raise InvalidParams("That signature is empty — draw something first.")

    min_x = max(0, min_x - padding)
    min_y = max(0, min_y - padding)
    max_x = min(width - 1, max_x + padding)
    max_y = min(height - 1, max_y + padding)
    if (min_x, min_y, max_x, max_y) == (0, 0, width - 1, height - 1):
        return data

    # Built from raw samples. PyMuPDF's "scaled copy with clip" constructor —
    # the obvious way to crop — **segfaults** on this input, and a crash inside
    # the worker is not a failure mode worth flirting with.
    new_w = max_x - min_x + 1
    new_h = max_y - min_y + 1
    rows = [samples[y * stride + min_x * n: y * stride + (max_x + 1) * n]
            for y in range(min_y, max_y + 1)]
    out = fitz.Pixmap(pixmap.colorspace, new_w, new_h, b"".join(rows), pixmap.alpha)
    return out.tobytes("png")


def render_typed(text: str, font: str = "caveat", *, height: int = 120) -> bytes:
    """A typed name as a transparent PNG in one of the vendored faces."""
    text = (text or "").strip()
    if not text:
        raise InvalidParams("Type your name first.")
    if len(text) > 100:
        raise InvalidParams("That name is too long to render as a signature.")
    filename = TYPED_FONTS.get(font)
    if filename is None:
        raise InvalidParams(f"Unknown signature font '{font}'. Choose one of "
                            f"{sorted(TYPED_FONTS)}.")
    path = os.path.normpath(os.path.join(FONT_DIR, filename))
    if not os.path.exists(path):  # pragma: no cover - packaging error
        raise EngineError(f"Signature font {filename} is missing from the image.")

    fontsize = height * 0.6
    face = fitz.Font(fontfile=path)
    width = int(face.text_length(text, fontsize=fontsize)) + 40
    doc = fitz.open()
    page = doc.new_page(width=width, height=height)
    page.insert_font(fontname="sig", fontfile=path)
    page.insert_text((20, height * 0.72), text, fontname="sig", fontsize=fontsize,
                     color=(0.06, 0.09, 0.16))
    # `alpha=True` already gives exactly what is wanted: ink opaque, the rest
    # transparent. Running the paper-removal pass over it inverted that — the
    # unpainted background is (0,0,0,0), whose *grey value* is 0, i.e. "as dark
    # as ink", so every typed signature came out an opaque black rectangle.
    pixmap = page.get_pixmap(alpha=True, dpi=150)
    doc.close()
    return trim_transparent(pixmap.tobytes("png"))


def remove_background(data: bytes, *, threshold: int = 200) -> bytes:
    """Photograph of ink on paper → ink on transparency.

    Luminance threshold, deliberately simple (phase-08 says "simple v1"). It is
    honest about what it is: the UI tells the user that a dark or shadowed
    photo will come out badly and that drawing is better.
    """
    return _whiten_to_alpha(data, threshold=threshold)


def _whiten_to_alpha(data: bytes, *, threshold: int = 200) -> bytes:
    source = fitz.Pixmap(data)
    if source.colorspace and source.n - bool(source.alpha) > 1:
        source = fitz.Pixmap(fitz.csGRAY, source)
    grey = fitz.Pixmap(source, 0) if source.alpha else source

    width, height = grey.width, grey.height
    n = grey.n
    samples = bytearray(grey.samples)
    rgba = bytearray(width * height * 4)
    for i in range(width * height):
        value = samples[i * n]
        alpha = 0 if value >= threshold else 255 - value
        rgba[i * 4 + 0] = value
        rgba[i * 4 + 1] = value
        rgba[i * 4 + 2] = value
        rgba[i * 4 + 3] = alpha
    out = fitz.Pixmap(fitz.csRGB, width, height, bytes(rgba), True)
    return out.tobytes("png")


def normalize_signature(data: bytes) -> bytes:
    """Whatever arrived → ink on transparency, trimmed to the ink.

    One function because there are three ways in — the pad's canvas, a saved
    signature, and the ceremony's own dialog — and they were normalizing
    differently. A photograph has no alpha channel, so `trim_transparent` was a
    no-op on it and the *paper* got stamped onto the contract.
    """
    png = to_png(data)
    pixmap = _open_image(png)
    if not pixmap.alpha:
        png = remove_background(png)
    return trim_transparent(png)


def _content_rotation(page) -> int:
    """`geometry.content_rotation` for a page — see there for why it is `N`."""
    return content_rotation(page.rotation)


def _derotate(page, rect: fitz.Rect) -> tuple[float, float, float, float]:
    """A display-space rect → the page's unrotated space."""
    return apply_matrix_rect(rect.x0, rect.y0, rect.x1, rect.y1,
                             tuple(page.derotation_matrix))


def _place_rect(page, norm: NormRect) -> fitz.Rect:
    """A §8 normalized rect → where `insert_image`/`insert_textbox` want it.

    **Every** PyMuPDF writer takes the page's unrotated space — including
    `insert_htmlbox`, which §8's table used to exempt and which measurement
    says is no different (see §8's amendment of 2026-08-23). Without the
    de-rotation a signature placed at the top-left of a landscape page lands
    off the right edge. De-rotating the box is only half of it: the content
    also has to be turned, which is `_content_rotation`.
    """
    x0, y0, x1, y1 = norm_to_page_rect(norm, page.rect.width, page.rect.height)
    return fitz.Rect(*_derotate(page, fitz.Rect(x0, y0, x1, y1)))


def fit_text(page, rect: fitz.Rect, text: str, *, max_size: float = 9,
             color=(0, 0, 0), align=fitz.TEXT_ALIGN_LEFT) -> float:
    """Write `text` inside `rect`, shrinking until it fits. Returns the size used.

    `rect` is in the page's **unrotated** space (what `_place_rect` returns);
    the rotation is taken from the page, so no caller can forget it. Without it
    the glyphs are laid along the wrong axis of a rotated box and wrap every
    two or three characters — the date came out as `202|6-0|8-2|3`, which still
    *extracts* as the right characters and so fooled every text assertion.

    `insert_textbox` returns a negative number and **writes nothing** when the
    text does not fit — so a date in a box a person drew thin, or a tick in a
    small square, simply vanished from the finished document while the signer
    was told it was filled in.
    """
    rotate = _content_rotation(page)
    size = max_size
    while size >= 4:
        if page.insert_textbox(rect, text, fontsize=size, fontname="helv",
                               color=color, rotate=rotate, align=align) >= 0:
            return size
        size -= 1
    # Nothing fits the box. Draw it anyway, on the baseline, rather than
    # silently dropping what somebody typed. `insert_text` has no `rotate=` of
    # its own — a morph about the baseline anchor is the only way to turn it —
    # and the anchor has to be the *displayed* bottom-left, which on a rotated
    # page is a different corner of the unrotated rect.
    display = rect * page.rotation_matrix
    anchor = apply_matrix_rect(display.x0, display.y1, display.x0, display.y1,
                               tuple(page.derotation_matrix))[:2]
    page.insert_text(fitz.Point(*anchor), text, fontsize=4, fontname="helv",
                     color=color,
                     morph=(fitz.Point(*anchor), fitz.Matrix(rotate)))
    return 4


def self_sign(data: bytes, *, placements, images: dict[str, bytes],
              include_date: bool = False, date_text: str = "") -> bytes:
    """Stamp signature images onto pages and flatten (§10 `self_sign`).

    Always flattens: a signature that can be dragged off the page afterwards is
    a picture, not a signature. `insert_image` writes into the content stream,
    so there is nothing to flatten *away* — which is the property that makes
    this true rather than a claim.
    """
    placements = list(placements or [])
    if not placements:
        raise InvalidParams("Place the signature on the page first.")
    if len(placements) > MAX_PLACEMENTS:
        raise InvalidParams(f"At most {MAX_PLACEMENTS} placements at a time.")

    doc = fitz.open(stream=data, filetype="pdf")
    try:
        for placement in placements:
            index = int(placement.get("page", 0))
            if not 0 <= index < doc.page_count:
                raise InvalidParams(f"page {index} is out of range")
            key = str(placement.get("signature_id")
                      or placement.get("signature_upload_ref") or "")
            image = images.get(key)
            if not image:
                raise InvalidParams(f"Signature '{key}' was not found.")

            page = doc[index]
            try:
                norm = NormRect.from_dict(placement.get("rect"))
            except ValueError as exc:
                raise InvalidParams(f"invalid rect: {exc}") from exc
            rect = _place_rect(page, norm)
            # `keep_proportion` is the default and is wanted: a signature
            # stretched to the box is not the signature that was drawn.
            # `rotate` turns the image with the page — without it the signature
            # lands in the right place on a landscape page and is drawn lying
            # on its side (the same nuance the Phase-3 review queue noted for
            # image stamps).
            page.insert_image(rect, stream=image, overlay=True,
                              rotate=_content_rotation(page))

            if include_date and date_text:
                # "Below" is a statement about what the reader sees, so it is
                # measured in display space and de-rotated — exactly as
                # `_place_rect` does for the signature itself. Building it from
                # the already-de-rotated `rect` put the date *above* the
                # signature on a /Rotate 90 page and to its right on 270.
                display = rect * page.rotation_matrix
                below = fitz.Rect(display.x0, display.y1,
                                  display.x1, display.y1 + 16)
                fit_text(page, fitz.Rect(*_derotate(page, below)), date_text,
                         max_size=8, color=(0.25, 0.28, 0.33))
        return doc.tobytes(garbage=3, deflate=True)
    finally:
        doc.close()


def stamp_envelope_footer(data: bytes, *, code: str, verify_url: str) -> bytes:
    """"Envelope ZEN-XXXX · verify at …/verify" along the foot of every page.

    Deferred to finalize on purpose: the code has to survive on the *completed*
    document, and stamping it at send time would put it on the copy each
    recipient signs — where a later page insert would move it.
    """
    line = f"Envelope {code} · verify at {verify_url}"
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        for page in doc:
            # Along the foot of the page as *displayed*, which on a rotated
            # page is not the foot of the unrotated one.
            #
            # The band's height is in **points, not a fraction of the page**.
            # It used to be 0.02 of the display height, which is 17pt on a
            # portrait A4 and 8pt on a rotated A5 — under the line height. With
            # the rotation now honoured, `insert_textbox` answers a band that
            # short by writing *nothing* and returning a negative number that
            # nobody read, so the envelope code would have disappeared from
            # exactly the small rotated pages this fix exists to serve. Going
            # through `fit_text` means the worst case is small type rather than
            # a missing line of evidence.
            w, h = page.rect.width, page.rect.height
            band = fitz.Rect(w * 0.03, h - FOOTER_MARGIN - FOOTER_BAND,
                             w * 0.97, h - FOOTER_MARGIN)
            fit_text(page, fitz.Rect(*_derotate(page, band)), line,
                     max_size=FOOTER_SIZE, color=(0.42, 0.45, 0.5),
                     align=fitz.TEXT_ALIGN_CENTER)
        return doc.tobytes(garbage=3, deflate=True)
    finally:
        doc.close()


def png_size(data: bytes) -> tuple[int, int]:
    pixmap = _open_image(data)
    return pixmap.width, pixmap.height


def to_png(data: bytes) -> bytes:
    """Normalize any accepted image to PNG with alpha preserved."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return data
    pixmap = _open_image(data)
    buffer = io.BytesIO(pixmap.tobytes("png"))
    return buffer.getvalue()
