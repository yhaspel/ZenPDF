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
