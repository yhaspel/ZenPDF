"""Coordinate conversion — the ONLY place geometry math lives (01-architecture.md §8).

Client sends normalized page coordinates in **visual space**: origin top-left of
the page as displayed (rotation applied), x,y,w,h ∈ [0,1] relative to the displayed
page width/height. PyMuPDF's page coordinate space (page.rect) is also top-left
with rotation applied, so mapping to a fitz.Rect is a direct scale by displayed
width/height. Conversion to PDF-native bottom-left space is only done where a
library requires it (pyHanko visible-signature boxes, phase 8).
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class NormRect:
    """Normalized visual-space rectangle, all fields in [0, 1]."""

    x: float
    y: float
    w: float
    h: float

    def __post_init__(self):
        for name, val in (("x", self.x), ("y", self.y), ("w", self.w), ("h", self.h)):
            if not isinstance(val, (int, float)):
                raise ValueError(f"{name} must be numeric, got {val!r}")
        if self.w <= 0 or self.h <= 0:
            raise ValueError("width and height must be positive")
        # Allow tiny float overshoot but reject clearly-out-of-range values.
        eps = 1e-6
        if self.x < -eps or self.y < -eps:
            raise ValueError("x and y must be >= 0")
        if self.x + self.w > 1 + 1e-3 or self.y + self.h > 1 + 1e-3:
            raise ValueError("rectangle extends beyond the page")

    @classmethod
    def from_dict(cls, d: dict) -> NormRect:
        try:
            return cls(float(d["x"]), float(d["y"]), float(d["w"]), float(d["h"]))
        except (KeyError, TypeError) as exc:
            raise ValueError(f"invalid rect {d!r}") from exc


def norm_to_page_rect(rect: NormRect, page_width: float, page_height: float):
    """Map a normalized visual-space rect onto a page's displayed rect.

    Returns a 4-tuple (x0, y0, x1, y1) in the page's (rotation-applied) coordinate
    space — identical to PyMuPDF's page.rect space. Callers build a fitz.Rect from
    it; kept as a tuple so this module has no hard fitz dependency (testable pure).
    """
    if page_width <= 0 or page_height <= 0:
        raise ValueError("page dimensions must be positive")
    x0 = rect.x * page_width
    y0 = rect.y * page_height
    x1 = (rect.x + rect.w) * page_width
    y1 = (rect.y + rect.h) * page_height
    return (x0, y0, x1, y1)


Matrix = tuple[float, float, float, float, float, float]
IDENTITY: Matrix = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def apply_matrix_point(x: float, y: float, m: Matrix) -> tuple[float, float]:
    """Apply a PDF matrix `(a, b, c, d, e, f)` to a point.

    Needed because **display space and annotation space are not the same thing
    on a rotated page** (§8 amended). `page.rect` and `page.search_for` are
    rotation-applied, but `page.get_text("words")`, `annot.rect` and every
    `add_*_annot` call are in the page's *unrotated* space. On a /Rotate 90 page
    the two differ by a quarter turn, so a mark placed where the user clicked
    lands on the far side of the page unless it is de-rotated first.

    Kept as plain tuples so this module still has no fitz dependency: callers
    pass `tuple(page.derotation_matrix)` / `tuple(page.rotation_matrix)`.
    """
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def content_rotation(page_rotation: int) -> int:
    """How far to turn placed content so it reads upright **to the reader**.

    The other half of `apply_matrix_rect(…, derotation_matrix)`. De-rotating the
    box says *where* on a rotated page content goes; this says which way up it
    is drawn, and getting one without the other is the whole bug class fixed on
    2026-08-23.

    It is the page's rotation, not its opposite. `/Rotate N` turns the page N
    clockwise for display, while `insert_image`, `insert_textbox`,
    `insert_htmlbox`, `show_pdf_page` and an `insert_text` `morph` all turn
    their content *anti*-clockwise by the angle given — so the net turn the
    reader sees is `N - angle`, and the angle has to be `N`.

    The value used before, `(360 - N) % 360`, left a net of `2N - 360`: **zero
    at 0 and 180, a half-turn at 90 and 270.** That is why it survived so long.
    Every unrotated fixture agreed with it, and a 180° error is invisible to a
    bounding-box assertion because it *is* a symmetry of the bounding box —
    which is exactly how `test_a_signature_lands_where_it_was_put_on_a_rotated_page`
    passed on upside-down output for the whole of its life.

    `% 360` is defensive only: MuPDF normalizes `page.rotation` to
    {0, 90, 180, 270} for any raw `/Rotate`, including negative and >360.
    """
    return page_rotation % 360


def apply_matrix_rect(x0: float, y0: float, x1: float, y1: float,
                      m: Matrix) -> tuple[float, float, float, float]:
    """Apply a matrix to a rect and re-normalize it.

    Both corners are transformed and then min/max'd: a rotation maps top-left to
    bottom-left, so taking the results in order would produce an inside-out rect.
    """
    ax, ay = apply_matrix_point(x0, y0, m)
    bx, by = apply_matrix_point(x1, y1, m)
    return (min(ax, bx), min(ay, by), max(ax, bx), max(ay, by))


def norm_to_page_point(nx: float, ny: float, page_width: float,
                       page_height: float) -> tuple[float, float]:
    """Map a normalized visual-space point onto the page's displayed rect.

    Ink strokes, polygon vertices and line endpoints are points, not rects, and
    §8 is explicit that *all* conversions live here — so they get their own pair
    rather than each caller multiplying by the page size inline.
    """
    if page_width <= 0 or page_height <= 0:
        raise ValueError("page dimensions must be positive")
    return (float(nx) * page_width, float(ny) * page_height)


def page_point_to_norm(x: float, y: float, page_width: float,
                       page_height: float) -> tuple[float, float]:
    """Inverse of norm_to_page_point."""
    if page_width <= 0 or page_height <= 0:
        raise ValueError("page dimensions must be positive")
    return (float(x) / page_width, float(y) / page_height)


def page_rect_to_norm_clamped(x0: float, y0: float, x1: float, y1: float,
                              page_width: float, page_height: float) -> NormRect:
    """`page_rect_to_norm`, but clamped into the page instead of raising.

    For **read models**, which report where things already are. Real documents
    routinely place content outside the visible page — a CropBox inset for trim
    marks, or a full-bleed image deliberately overhanging the edge — and
    answering "this file is invalid" to a request that only asked *what is on
    page 1* turns an ordinary print PDF into a 500. Writers keep the strict
    version, because there a rect outside the page is a client bug worth naming.
    """
    if page_width <= 0 or page_height <= 0:
        raise ValueError("page dimensions must be positive")
    lo_x, hi_x = sorted((x0, x1))
    lo_y, hi_y = sorted((y0, y1))
    left = min(max(lo_x / page_width, 0.0), 1.0)
    top = min(max(lo_y / page_height, 0.0), 1.0)
    right = min(max(hi_x / page_width, 0.0), 1.0)
    bottom = min(max(hi_y / page_height, 0.0), 1.0)
    # A rect entirely off-page collapses; give it a sliver so it stays a valid
    # NormRect (which requires positive extent) and is visibly degenerate.
    return NormRect(x=left, y=top,
                    w=max(right - left, 1e-6), h=max(bottom - top, 1e-6))


def page_rect_to_norm(x0: float, y0: float, x1: float, y1: float,
                      page_width: float, page_height: float) -> NormRect:
    """Inverse of norm_to_page_rect — used to return search hits as normalized rects."""
    if page_width <= 0 or page_height <= 0:
        raise ValueError("page dimensions must be positive")
    lo_x, hi_x = sorted((x0, x1))
    lo_y, hi_y = sorted((y0, y1))
    return NormRect(
        x=lo_x / page_width,
        y=lo_y / page_height,
        w=(hi_x - lo_x) / page_width,
        h=(hi_y - lo_y) / page_height,
    )


def page_rect_to_pdf_native(x0: float, y0: float, x1: float, y1: float,
                            page) -> tuple[float, float, float, float]:
    """A page's **unrotated** PyMuPDF rect → the PDF's own user space.

    The one conversion §8 sanctions, for libraries that speak PDF natively —
    pyHanko's visible-signature boxes in phases 5 and 8.

    Deliberately not `~page.transformation_matrix`: measured on PyMuPDF 1.28,
    that matrix carries the page origin only when `page.rotation == 0`. On a
    rotated page it is computed against a zero-origin box, so the inverse
    silently drops the translation and a signature placed on a rotated page
    with an offset MediaBox lands a whole origin away — off the page, where
    clamping then hides it. The box arithmetic below was checked against the
    `/Rect` PyMuPDF itself writes, for rotations 0/90/270, an offset MediaBox
    and a CropBox inset inside it.
    """
    origin = page.cropbox_position           # top-left of the CropBox
    top = page.mediabox.y1 - origin.y        # PDF y of that top edge
    lo_x, hi_x = sorted((x0 + origin.x, x1 + origin.x))
    lo_y, hi_y = sorted((top - y0, top - y1))
    return (lo_x, lo_y, hi_x, hi_y)
