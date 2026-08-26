"""Coordinate system tests (01-architecture.md §8)."""
import pytest

from apps.pdf_engine.geometry import NormRect, norm_to_page_rect, page_rect_to_norm


def test_norm_rect_valid():
    r = NormRect(0.1, 0.2, 0.3, 0.4)
    assert (r.x, r.y, r.w, r.h) == (0.1, 0.2, 0.3, 0.4)


@pytest.mark.parametrize("bad", [
    {"x": -0.1, "y": 0, "w": 0.5, "h": 0.5},
    {"x": 0, "y": 0, "w": 0, "h": 0.5},
    {"x": 0, "y": 0, "w": 0.5, "h": 0},
    {"x": 0.8, "y": 0, "w": 0.5, "h": 0.5},  # extends past right edge
])
def test_norm_rect_rejects_out_of_range(bad):
    with pytest.raises(ValueError):
        NormRect(**bad)


def test_norm_rect_from_dict_rounds_to_the_wire_precision():
    """A handle dragged onto the page edge arrives as x = 9.1e-09, and a
    FreeText rect with a non-zero origin below MuPDF's epsilon never finishes
    rendering. Six decimals is what the readers write; reading the same keeps
    the residue out of the engine."""
    r = NormRect.from_dict({"x": 9.11823084637593e-09, "y": 0.0, "w": 0.7127777777777775, "h": 0.456830759058099})
    assert r.x == 0.0
    assert r.w == 0.712778
    assert r.h == 0.456831
    # …and a value that is merely small is kept, not snapped.
    assert NormRect.from_dict({"x": 1e-6, "y": 0.5, "w": 0.1, "h": 0.1}).x == 1e-6
    # A width that rounds away is refused, never silently drawn as nothing.
    with pytest.raises(ValueError):
        NormRect.from_dict({"x": 0.5, "y": 0.5, "w": 4e-7, "h": 0.1})


def test_norm_rect_from_dict():
    r = NormRect.from_dict({"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0})
    assert r.w == 1.0
    with pytest.raises(ValueError):
        NormRect.from_dict({"x": 0.0})


def test_norm_to_page_rect_scales():
    r = NormRect(0.25, 0.5, 0.5, 0.25)
    x0, y0, x1, y1 = norm_to_page_rect(r, 400, 800)
    assert (x0, y0, x1, y1) == (100.0, 400.0, 300.0, 600.0)


def test_norm_to_page_rect_rejects_bad_dims():
    with pytest.raises(ValueError):
        norm_to_page_rect(NormRect(0, 0, 1, 1), 0, 100)


def test_round_trip():
    r = NormRect(0.2, 0.3, 0.4, 0.1)
    x0, y0, x1, y1 = norm_to_page_rect(r, 595, 842)
    back = page_rect_to_norm(x0, y0, x1, y1, 595, 842)
    assert back.x == pytest.approx(r.x)
    assert back.y == pytest.approx(r.y)
    assert back.w == pytest.approx(r.w)
    assert back.h == pytest.approx(r.h)


def test_page_rect_to_norm_normalizes_swapped_corners():
    # A derotation may hand back x1<x0; the helper must normalize.
    nr = page_rect_to_norm(300, 600, 100, 400, 400, 800)
    assert nr.x == pytest.approx(0.25)
    assert nr.w == pytest.approx(0.5)
