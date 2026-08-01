"""Per-operation JSON Schemas (01-architecture.md §10).

Used both to validate incoming operation params and (via drf-spectacular) to
document them. Kept as plain dicts so they are import-cheap and language-neutral.
"""

_PAGES = {"type": "array", "items": {"type": "integer", "minimum": 0}, "minItems": 1}
_NORM_RECT = {
    "type": "object",
    "required": ["x", "y", "w", "h"],
    "properties": {
        "x": {"type": "number", "minimum": 0, "maximum": 1},
        "y": {"type": "number", "minimum": 0, "maximum": 1},
        "w": {"type": "number", "exclusiveMinimum": 0, "maximum": 1},
        "h": {"type": "number", "exclusiveMinimum": 0, "maximum": 1},
    },
    "additionalProperties": False,
}
_SIZE = {"type": "string", "enum": ["a4", "letter", "legal", "match-previous"]}

ROTATE_PAGES = {
    "type": "object",
    "required": ["pages", "degrees"],
    "properties": {"pages": _PAGES, "degrees": {"enum": [90, 180, 270]}},
    "additionalProperties": False,
}
DELETE_PAGES = {"type": "object", "required": ["pages"],
                "properties": {"pages": _PAGES}, "additionalProperties": False}
DUPLICATE_PAGES = DELETE_PAGES
REORDER_PAGES = {
    "type": "object",
    "required": ["new_order"],
    "properties": {"new_order": {"type": "array", "items": {"type": "integer", "minimum": 0}}},
    "additionalProperties": False,
}
EXTRACT_PAGES = {
    "type": "object",
    "required": ["pages"],
    "properties": {"pages": _PAGES, "as_new_document": {"type": "boolean"}},
    "additionalProperties": False,
}
INSERT_BLANK = {
    "type": "object",
    "required": ["at_index"],
    "properties": {
        "at_index": {"type": "integer", "minimum": 0},
        "count": {"type": "integer", "minimum": 1, "maximum": 100},
        "size": _SIZE,
    },
    "additionalProperties": False,
}
INSERT_FROM_DOCUMENT = {
    "type": "object",
    "required": ["source_document_id", "at_index"],
    "properties": {
        "source_document_id": {"type": "string"},
        "source_pages": {"type": "array", "items": {"type": "integer", "minimum": 0}},
        "at_index": {"type": "integer", "minimum": 0},
    },
    "additionalProperties": False,
}
CROP_PAGES = {
    "type": "object",
    "required": ["pages", "rect"],
    "properties": {"pages": _PAGES, "rect": _NORM_RECT},
    "additionalProperties": False,
}
SCALE_PAGES = {
    "type": "object",
    "required": ["pages"],
    "properties": {"pages": _PAGES, "target_size": _SIZE},
    "additionalProperties": False,
}
NUP = {
    "type": "object",
    "properties": {"per_sheet": {"enum": [2, 4]}, "page_size": _SIZE},
    "additionalProperties": False,
}
COMPRESS = {
    "type": "object",
    "properties": {
        "preset": {"enum": ["light", "balanced", "strong"]},
        "image_dpi": {"type": "integer", "minimum": 36, "maximum": 600},
    },
    "additionalProperties": False,
}
SPLIT = {
    "type": "object",
    "required": ["mode"],
    "properties": {
        "mode": {"enum": ["ranges", "every_n", "by_size_mb", "by_bookmarks"]},
        "ranges": {"type": "string"},
        "every_n": {"type": "integer", "minimum": 1},
        "max_mb": {"type": "number", "exclusiveMinimum": 0},
    },
    "additionalProperties": False,
}
MERGE = {
    "type": "object",
    "required": ["document_ids"],
    "properties": {"document_ids": {"type": "array", "items": {"type": "string"}, "minItems": 2}},
    "additionalProperties": False,
}
ALTERNATE_MIX = {
    "type": "object",
    "required": ["document_a", "document_b"],
    "properties": {
        "document_a": {"type": "string"},
        "document_b": {"type": "string"},
        "reverse_b": {"type": "boolean"},
    },
    "additionalProperties": False,
}

# --------------------------------------------------------------------------- #
# Phase 3 — annotations
# --------------------------------------------------------------------------- #
_COLOR = {"type": "string", "pattern": "^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$"}
_POINT = {
    "type": "array",
    "items": {"type": "number", "minimum": -0.5, "maximum": 1.5},
    "minItems": 2,
    "maxItems": 2,
}
_MARKUP_TYPES = ["highlight", "underline", "strikeout", "squiggly"]
_STAMP_NAMES = [
    "Approved", "AsIs", "Confidential", "Departmental", "Draft", "Experimental",
    "Expired", "Final", "ForComment", "ForPublicRelease", "NotApproved",
    "NotForPublicRelease", "Sold", "TopSecret",
]
ANNOTATION_TYPES = [
    *_MARKUP_TYPES, "note", "free_text", "square", "circle", "line", "arrow",
    "polygon", "polyline", "ink", "stamp", "image_stamp",
]

# One schema with `if/then` branches per type, rather than a bare oneOf: a
# failing oneOf reports "no branch matched", which tells the client nothing,
# while if/then reports the actual missing key.
ANNOTATION = {
    "type": "object",
    "required": ["id", "type", "page"],
    "properties": {
        # Client-generated UUID → the PDF /NM key, so batch updates and deletes
        # address stable ids across extract→apply cycles (phase-03 §3).
        "id": {"type": "string", "minLength": 1, "maxLength": 64},
        "page": {"type": "integer", "minimum": 0},
        "type": {"enum": ANNOTATION_TYPES},
        "rect": _NORM_RECT,
        "quads": {"type": "array", "items": _NORM_RECT, "minItems": 1, "maxItems": 2000},
        "ink": {
            "type": "array",
            "items": {"type": "array", "items": _POINT, "minItems": 1, "maxItems": 5000},
            "minItems": 1,
            "maxItems": 500,
        },
        "vertices": {"type": "array", "items": _POINT, "minItems": 2, "maxItems": 500},
        "color": _COLOR,
        "fill": _COLOR,
        "opacity": {"type": "number", "minimum": 0, "maximum": 1},
        "width": {"type": "number", "minimum": 0, "maximum": 50},
        "contents": {"type": "string", "maxLength": 5000},
        "author": {"type": "string", "maxLength": 120},
        "created": {"type": "string", "maxLength": 40},
        "modified": {"type": "string", "maxLength": 40},
        "icon": {
            "enum": ["Note", "Comment", "Help", "Insert", "Key", "NewParagraph",
                     "Paragraph"]
        },
        "font_size": {"type": "number", "minimum": 4, "maximum": 96},
        "align": {"enum": [0, 1, 2]},
        "stamp_name": {"enum": _STAMP_NAMES},
        "image_ref": {"type": "string", "pattern": "^[A-Za-z0-9_-]{6,64}$"},
    },
    "additionalProperties": False,
    "allOf": [
        {"if": {"properties": {"type": {"enum": _MARKUP_TYPES}}, "required": ["type"]},
         "then": {"required": ["quads"]}},
        {"if": {"properties": {"type": {"const": "ink"}}, "required": ["type"]},
         "then": {"required": ["ink"]}},
        {"if": {"properties": {"type": {"enum": ["line", "arrow", "polygon", "polyline"]}},
                "required": ["type"]},
         "then": {"required": ["vertices"]}},
        {"if": {"properties": {"type": {"enum": ["note", "free_text", "square", "circle",
                                                 "stamp", "image_stamp"]}},
                "required": ["type"]},
         "then": {"required": ["rect"]}},
        {"if": {"properties": {"type": {"const": "image_stamp"}}, "required": ["type"]},
         "then": {"required": ["image_ref"]}},
    ],
}

# A delete only needs the id — the client should not have to echo a whole
# annotation back just to remove it.
_ANNOTATION_REF = {
    "type": "object",
    "required": ["id"],
    "properties": {"id": {"type": "string", "minLength": 1, "maxLength": 64}},
}

ANNOTATE_BATCH = {
    "type": "object",
    "required": ["ops"],
    "properties": {
        "ops": {
            "type": "array",
            "minItems": 1,
            # A save is one job per session (phase-03 §2); 1000 ops is far above
            # the 30-annotation acceptance target and still bounds worker time.
            "maxItems": 1000,
            "items": {
                "type": "object",
                "required": ["action", "annotation"],
                "properties": {
                    "action": {"enum": ["add", "update", "delete"]},
                    "annotation": {"type": "object"},
                },
                "additionalProperties": False,
                "allOf": [
                    {"if": {"properties": {"action": {"const": "delete"}},
                            "required": ["action"]},
                     "then": {"properties": {"annotation": _ANNOTATION_REF}}},
                    {"if": {"properties": {"action": {"enum": ["add", "update"]}},
                            "required": ["action"]},
                     "then": {"properties": {"annotation": ANNOTATION}}},
                ],
            },
        },
    },
    "additionalProperties": False,
}

FLATTEN = {
    "type": "object",
    "properties": {"what": {"enum": ["annotations", "form", "all"]}},
    "additionalProperties": False,
}
