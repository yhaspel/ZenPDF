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
