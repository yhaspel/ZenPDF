"""Operation registry (01-architecture.md §10) — the law for op dispatch.

Maps each operation type to its queue (§12), param JSON Schema (§10), what it
produces, and which params reference *other* documents (cross-document ops).
"""
from __future__ import annotations

from dataclasses import dataclass, field

from . import schemas as S
from .exceptions import InvalidParams


@dataclass(frozen=True)
class Op:
    type: str
    queue: str
    schema: dict
    produces: str  # "version" | "documents"
    source_id_params: tuple = field(default_factory=tuple)

    @property
    def is_cross_document(self) -> bool:
        # A cross-document op takes ALL its inputs from params (no primary doc
        # in the URL): merge / alternate_mix.
        return self.type in {"merge", "alternate_mix"}


OPERATIONS: dict[str, Op] = {
    "rotate_pages": Op("rotate_pages", "default", S.ROTATE_PAGES, "version"),
    "delete_pages": Op("delete_pages", "default", S.DELETE_PAGES, "version"),
    "duplicate_pages": Op("duplicate_pages", "default", S.DUPLICATE_PAGES, "version"),
    "reorder_pages": Op("reorder_pages", "default", S.REORDER_PAGES, "version"),
    "extract_pages": Op("extract_pages", "default", S.EXTRACT_PAGES, "version"),
    "insert_blank": Op("insert_blank", "default", S.INSERT_BLANK, "version"),
    "insert_from_document": Op(
        "insert_from_document", "default", S.INSERT_FROM_DOCUMENT, "version",
        source_id_params=("source_document_id",),
    ),
    "crop_pages": Op("crop_pages", "default", S.CROP_PAGES, "version"),
    "scale_pages": Op("scale_pages", "default", S.SCALE_PAGES, "version"),
    "nup": Op("nup", "default", S.NUP, "version"),
    "compress": Op("compress", "heavy", S.COMPRESS, "version"),
    "split": Op("split", "default", S.SPLIT, "documents"),
    "merge": Op("merge", "heavy", S.MERGE, "documents",
                source_id_params=("document_ids",)),
    "alternate_mix": Op("alternate_mix", "heavy", S.ALTERNATE_MIX, "documents",
                        source_id_params=("document_a", "document_b")),
    # Phase 3 — annotations (§10, §12: both on the `default` queue)
    "annotate_batch": Op("annotate_batch", "default", S.ANNOTATE_BATCH, "version"),
    "flatten": Op("flatten", "default", S.FLATTEN, "version"),
    # Phase 4 — content editing (§10; §12 puts text/image edits and stamps on
    # `default`)
    "edit_text": Op("edit_text", "default", S.EDIT_TEXT, "version"),
    "add_text": Op("add_text", "default", S.ADD_TEXT, "version"),
    "whiteout": Op("whiteout", "default", S.WHITEOUT, "version"),
    "find_replace": Op("find_replace", "default", S.FIND_REPLACE, "version"),
    "add_image": Op("add_image", "default", S.ADD_IMAGE, "version"),
    "replace_image": Op("replace_image", "default", S.REPLACE_IMAGE, "version"),
    "delete_image": Op("delete_image", "default", S.DELETE_IMAGE, "version"),
    "add_link": Op("add_link", "default", S.ADD_LINK, "version"),
    "edit_link": Op("edit_link", "default", S.EDIT_LINK, "version"),
    "delete_link": Op("delete_link", "default", S.DELETE_LINK, "version"),
    "header_footer": Op("header_footer", "default", S.HEADER_FOOTER, "version"),
    "page_numbers": Op("page_numbers", "default", S.PAGE_NUMBERS, "version"),
    "bates": Op("bates", "default", S.BATES, "version"),
    "watermark": Op("watermark", "default", S.WATERMARK, "version"),
    "overlay_pdf": Op("overlay_pdf", "default", S.OVERLAY_PDF, "version",
                      source_id_params=("overlay_document_id",)),
    "set_metadata": Op("set_metadata", "default", S.SET_METADATA, "version"),
    "set_bookmarks": Op("set_bookmarks", "default", S.SET_BOOKMARKS, "version"),
}


def get_op(op_type: str) -> Op:
    op = OPERATIONS.get(op_type)
    if op is None:
        raise InvalidParams(f"Unknown operation type '{op_type}'.")
    return op


def validate_params(op_type: str, params: dict) -> None:
    """Validate params against the op's JSON Schema; raise InvalidParams."""
    import jsonschema

    op = get_op(op_type)
    try:
        jsonschema.validate(instance=params or {}, schema=op.schema)
    except jsonschema.ValidationError as exc:
        raise InvalidParams(f"Invalid params for {op_type}: {exc.message}") from exc
