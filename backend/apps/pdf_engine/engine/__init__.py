"""Pure PDF engine functions. The ONLY module tree importing fitz/pikepdf/etc.

Every function is pure: (bytes | list[bytes], params) -> bytes | list[bytes] | dict.
No Django, no storage, no network — so they are trivially golden-testable.
"""
from .annotations import (
    apply_annotation_ops,
    extract_annotations,
    flatten_annotations,
)
from .inspect import inspect
from .render import render_page, render_thumbnail
from .search import search_text
from .text import page_words
from .validate import repair_pdf, validate_pdf

__all__ = [
    "inspect",
    "render_page",
    "render_thumbnail",
    "search_text",
    "validate_pdf",
    "repair_pdf",
    "apply_annotation_ops",
    "extract_annotations",
    "flatten_annotations",
    "page_words",
]
