"""Colour parsing shared by the engine modules.

PDF works in 0..1 float components; the wire uses `#rrggbb`. Lives on its own
so `content.py` (phase 4) and `annotations.py` (phase 3) — and redaction fills
in phase 7 — agree on exactly one parser rather than each growing their own.
"""
from __future__ import annotations

from .exceptions import InvalidParams


def parse_color(value) -> tuple[float, float, float] | None:
    """'#rrggbb' | '#rgb' | [r,g,b] (0..1) → (r, g, b) floats; None passes through."""
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        if len(value) != 3:
            raise InvalidParams("color arrays must have exactly 3 components")
        return tuple(max(0.0, min(1.0, float(c))) for c in value)  # type: ignore[return-value]
    text = str(value).strip().lstrip("#")
    if len(text) == 3:
        text = "".join(c * 2 for c in text)
    if len(text) != 6:
        raise InvalidParams(f"invalid color {value!r}; expected #rrggbb")
    try:
        return tuple(int(text[i:i + 2], 16) / 255.0 for i in (0, 2, 4))  # type: ignore[return-value]
    except ValueError as exc:
        raise InvalidParams(f"invalid color {value!r}") from exc


def format_color(components) -> str | None:
    if not components:
        return None
    vals = list(components)[:3]
    if len(vals) < 3:  # grayscale or CMYK stroke — normalize to gray
        vals = [vals[0]] * 3 if vals else [0.0, 0.0, 0.0]
    return "#" + "".join(f"{max(0, min(255, round(c * 255))):02x}" for c in vals)


def css_color(value, default: str = "#000000") -> str:
    """A `#rrggbb` string safe to interpolate into a CSS declaration.

    Goes through `parse_color`, so anything that is not a colour is rejected
    rather than being pasted into a stylesheet.
    """
    rgb = parse_color(value) if value is not None else None
    if rgb is None:
        return default
    return format_color(rgb) or default


def int_color(value) -> int:
    """0xRRGGBB, the form PyMuPDF's text-extraction dict reports."""
    rgb = parse_color(value) or (0.0, 0.0, 0.0)
    return (round(rgb[0] * 255) << 16) | (round(rgb[1] * 255) << 8) | round(rgb[2] * 255)


def from_int(value: int) -> str:
    """Inverse of `int_color`, for the text read model."""
    value = int(value) & 0xFFFFFF
    return f"#{value:06x}"
