"""Per-operation JSON Schemas (01-architecture.md §10).

Used both to validate incoming operation params and (via drf-spectacular) to
document them. Kept as plain dicts so they are import-cheap and language-neutral.
"""

# `maxItems` is a backstop, not the limit: the tier page cap is enforced at
# runtime in `documents.tasks` against the *result*, which is the number that
# actually matters. This only stops a million-element array from being decoded
# and walked before anyone measures anything, and is set well above any document
# a real user has (§10).
_PAGES = {"type": "array", "items": {"type": "integer", "minimum": 0},
          "minItems": 1, "maxItems": 10000}
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
# `null` is accepted, not just omitted: extraction reports an unset colour as
# `null`, and the client edits an annotation by sending back what it was given.
# A string-only schema meant any annotation loaded from the server 400'd the
# moment it was edited — and it took the whole batch with it.
_COLOR = {
    "type": ["string", "null"],
    "pattern": "^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$",
}
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


# --------------------------------------------------------------------------- #
# Phase 4 — content editing
# --------------------------------------------------------------------------- #
_TEXT_STYLE = {
    "type": "object",
    "properties": {
        "font_family": {"enum": ["helvetica", "sans-serif", "times", "serif",
                                 "courier", "monospace"]},
        "size": {"type": "number", "minimum": 4, "maximum": 200},
        "color": _COLOR,
        "align": {"enum": ["left", "center", "right", "justify"]},
        "bold": {"type": "boolean"},
        "italic": {"type": "boolean"},
    },
    "additionalProperties": False,
}
# `pages` omitted means every page; `skip_first` is the "not on the cover" case
# every stamping tool needs.
_RANGE = {
    "type": "object",
    "properties": {
        "pages": {"type": "array", "items": {"type": "integer", "minimum": 0}},
        "skip_first": {"type": "boolean"},
    },
    "additionalProperties": False,
}
_POSITION = {
    "enum": ["top-left", "top-center", "top-right",
             "bottom-left", "bottom-center", "bottom-right"],
}
_IMAGE_REF = {"type": "string", "pattern": "^[A-Za-z0-9_-]{6,64}$"}

EDIT_TEXT = {
    "type": "object",
    "required": ["edits"],
    "properties": {
        "edits": {
            "type": "array",
            "minItems": 1,
            "maxItems": 200,
            "items": {
                "type": "object",
                "required": ["page", "block_bbox", "new_text"],
                "properties": {
                    "page": {"type": "integer", "minimum": 0},
                    "block_bbox": _NORM_RECT,
                    "new_text": {"type": "string", "maxLength": 20000},
                    "style": _TEXT_STYLE,
                },
                "additionalProperties": False,
            },
        },
    },
    "additionalProperties": False,
}

ADD_TEXT = {
    "type": "object",
    "required": ["boxes"],
    "properties": {
        "boxes": {
            "type": "array",
            "minItems": 1,
            "maxItems": 200,
            "items": {
                "type": "object",
                "required": ["page", "rect", "text"],
                "properties": {
                    "page": {"type": "integer", "minimum": 0},
                    "rect": _NORM_RECT,
                    "text": {"type": "string", "maxLength": 20000},
                    "style": _TEXT_STYLE,
                },
                "additionalProperties": False,
            },
        },
    },
    "additionalProperties": False,
}

WHITEOUT = {
    "type": "object",
    "required": ["rects"],
    "properties": {
        "rects": {
            "type": "array",
            "minItems": 1,
            "maxItems": 500,
            "items": {
                "type": "object",
                "required": ["page", "rect"],
                "properties": {
                    "page": {"type": "integer", "minimum": 0},
                    "rect": _NORM_RECT,
                },
                "additionalProperties": False,
            },
        },
        "color": _COLOR,
    },
    "additionalProperties": False,
}

FIND_REPLACE = {
    "type": "object",
    "required": ["find"],
    "properties": {
        "find": {"type": "string", "minLength": 1, "maxLength": 500},
        "replace": {"type": "string", "maxLength": 500},
        "match_case": {"type": "boolean"},
        "pages": {"type": "array", "items": {"type": "integer", "minimum": 0}},
        "dry_run": {"type": "boolean"},
        # Match ids from the dry run the user chose to keep.
        "only": {"type": "array", "items": {"type": "string", "maxLength": 32},
                 "maxItems": 5000},
    },
    "additionalProperties": False,
}

ADD_IMAGE = {
    "type": "object",
    "required": ["page", "rect", "image_ref"],
    "properties": {
        "page": {"type": "integer", "minimum": 0},
        "rect": _NORM_RECT,
        "image_ref": _IMAGE_REF,
        "keep_aspect": {"type": "boolean"},
    },
    "additionalProperties": False,
}
REPLACE_IMAGE = {
    "type": "object",
    "required": ["page", "xref", "image_ref"],
    "properties": {
        "page": {"type": "integer", "minimum": 0},
        "xref": {"type": "integer", "minimum": 1},
        "image_ref": _IMAGE_REF,
    },
    "additionalProperties": False,
}
DELETE_IMAGE = {
    "type": "object",
    "required": ["page", "xref"],
    "properties": {
        "page": {"type": "integer", "minimum": 0},
        "xref": {"type": "integer", "minimum": 1},
    },
    "additionalProperties": False,
}

_LINK_TARGET = {
    "kind": {"enum": ["uri", "page"]},
    "uri": {"type": "string", "maxLength": 2000},
    "page_target": {"type": "integer", "minimum": 0},
}
ADD_LINK = {
    "type": "object",
    "required": ["page", "rect"],
    "properties": {
        "page": {"type": "integer", "minimum": 0},
        "rect": _NORM_RECT,
        **_LINK_TARGET,
    },
    "additionalProperties": False,
}
EDIT_LINK = {
    "type": "object",
    "required": ["page", "index", "rect"],
    "properties": {
        "page": {"type": "integer", "minimum": 0},
        "index": {"type": "integer", "minimum": 0},
        "rect": _NORM_RECT,
        **_LINK_TARGET,
    },
    "additionalProperties": False,
}
DELETE_LINK = {
    "type": "object",
    "required": ["page", "index"],
    "properties": {
        "page": {"type": "integer", "minimum": 0},
        "index": {"type": "integer", "minimum": 0},
    },
    "additionalProperties": False,
}

HEADER_FOOTER = {
    "type": "object",
    "required": ["segments"],
    "properties": {
        "segments": {
            "type": "object",
            "properties": {p: {"type": "string", "maxLength": 300}
                           for p in _POSITION["enum"]},
            "additionalProperties": False,
            "minProperties": 1,
        },
        "style": _TEXT_STYLE,
        "margin": {"type": "number", "minimum": 0, "maximum": 200},
        "range": _RANGE,
        "start_at": {"type": "integer", "minimum": 0},
    },
    "additionalProperties": False,
}

PAGE_NUMBERS = {
    "type": "object",
    "properties": {
        "position": _POSITION,
        "format": {"type": "string", "maxLength": 100},
        "start_at": {"type": "integer", "minimum": 0},
        "style": _TEXT_STYLE,
        "margin": {"type": "number", "minimum": 0, "maximum": 200},
        "range": _RANGE,
    },
    "additionalProperties": False,
}

BATES = {
    "type": "object",
    "properties": {
        "prefix": {"type": "string", "maxLength": 50},
        "suffix": {"type": "string", "maxLength": 50},
        "start": {"type": "integer", "minimum": 0},
        "digits": {"type": "integer", "minimum": 1, "maximum": 12},
        "position": _POSITION,
        "style": _TEXT_STYLE,
        "margin": {"type": "number", "minimum": 0, "maximum": 200},
        "range": _RANGE,
    },
    "additionalProperties": False,
}

WATERMARK = {
    "type": "object",
    "properties": {
        "text": {"type": "string", "maxLength": 200},
        "image_ref": _IMAGE_REF,
        "opacity": {"type": "number", "exclusiveMinimum": 0, "maximum": 1},
        "rotation": {"type": "integer", "minimum": -360, "maximum": 360},
        "scale": {"type": "number", "exclusiveMinimum": 0, "maximum": 5},
        "tiled": {"type": "boolean"},
        "color": _COLOR,
        "size": {"type": "number", "minimum": 4, "maximum": 200},
        "under": {"type": "boolean"},
        "range": _RANGE,
    },
    "additionalProperties": False,
    # Exactly the "needs text or an image" rule the engine enforces, stated so
    # the rejection happens before a job is created.
    "anyOf": [{"required": ["text"]}, {"required": ["image_ref"]}],
}

OVERLAY_PDF = {
    "type": "object",
    "required": ["overlay_document_id"],
    "properties": {
        "overlay_document_id": {"type": "string"},
        "mode": {"enum": ["foreground", "background"]},
        "overlay_page": {"type": "integer", "minimum": 0},
        "range": _RANGE,
    },
    "additionalProperties": False,
}

SET_METADATA = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "maxLength": 500},
        "author": {"type": "string", "maxLength": 500},
        "subject": {"type": "string", "maxLength": 500},
        "keywords": {"type": "string", "maxLength": 500},
        "creator": {"type": "string", "maxLength": 500},
        "producer": {"type": "string", "maxLength": 500},
        "clear": {"type": "boolean"},
    },
    "additionalProperties": False,
}

SET_BOOKMARKS = {
    "type": "object",
    "required": ["toc"],
    "properties": {
        "toc": {
            "type": "array",
            "maxItems": 5000,
            "items": {
                "type": "array",
                "minItems": 3,
                "maxItems": 3,
                "prefixItems": [
                    {"type": "integer", "minimum": 1, "maximum": 12},
                    {"type": "string", "maxLength": 500},
                    {"type": "integer", "minimum": 1},
                ],
            },
        },
    },
    "additionalProperties": False,
}


# --------------------------------------------------------------------------- #
# Phase 5 — forms
# --------------------------------------------------------------------------- #
FILL_FORM = {
    "type": "object",
    "required": ["values"],
    "properties": {
        # Values are typed by the *field*, not by the wire: a checkbox accepts a
        # bool or "yes"/"on", a choice field accepts one of its options.
        #
        # Bounded on both axes, like every other schema here. Params are stored
        # on the Job row and echoed on every poll, so an uncapped map is a
        # quota-free write into Postgres and a read amplifier — a guest could
        # park megabytes per job and re-download them 40×/minute.
        "values": {
            "type": "object",
            "minProperties": 1,
            "maxProperties": 1000,
            "additionalProperties": {
                "type": ["string", "boolean", "number", "null"],
                "maxLength": 20000,
            },
        },
        "flatten_after": {"type": "boolean"},
    },
    "additionalProperties": False,
}

_FIELD_SPEC = {
    "type": "object",
    "required": ["name"],
    "properties": {
        "name": {"type": "string", "minLength": 1, "maxLength": 200},
        "type": {"enum": ["text", "checkbox", "radio", "combobox", "listbox",
                          "signature"]},
        "page": {"type": "integer", "minimum": 0},
        "rect": _NORM_RECT,
        # A radio group is N placements of one field, so it carries N rects.
        "rects": {"type": "array", "items": _NORM_RECT, "minItems": 2, "maxItems": 50},
        # `minLength: 1` is load-bearing: an empty option becomes `Name("/")`,
        # which pikepdf refuses — a 500-shaped failure for a 400-shaped input.
        "options": {"type": "array",
                    "items": {"type": "string", "minLength": 1, "maxLength": 200},
                    "maxItems": 200},
        "default": {"type": ["string", "boolean", "null"]},
        "required": {"type": "boolean"},
        "readonly": {"type": "boolean"},
        "multiline": {"type": "boolean"},
        "max_len": {"type": "integer", "minimum": 0, "maximum": 10000},
        "font_size": {"type": "number", "minimum": 4, "maximum": 96},
        "align": {"enum": ["left", "center", "right"]},
    },
    "additionalProperties": False,
}

EDIT_FORM_FIELDS_BATCH = {
    "type": "object",
    "required": ["ops"],
    "properties": {
        "ops": {
            "type": "array",
            "minItems": 1,
            "maxItems": 200,
            "items": {
                "type": "object",
                "required": ["action", "field"],
                "properties": {
                    "action": {"enum": ["add", "update", "delete"]},
                    "field": _FIELD_SPEC,
                },
                "additionalProperties": False,
            },
        },
    },
    "additionalProperties": False,
}

IMPORT_FORM_DATA = {
    "type": "object",
    "required": ["format", "data"],
    "properties": {
        "format": {"enum": ["json", "csv"]},
        # The file contents, inline: form data is small and this keeps the
        # import on the same job pipeline as every other mutation. The cap is
        # ~25 000 `name,value` rows — far past any real form — and is what
        # keeps the payload, which is retained on the Job row and echoed on
        # every poll, from becoming a quota-free store-and-amplify.
        "data": {"type": "string", "maxLength": 500_000},
        "flatten_after": {"type": "boolean"},
    },
    "additionalProperties": False,
}


# --------------------------------------------------------------------------- #
# Phase 6 — OCR, conversion, compare, repair
# --------------------------------------------------------------------------- #
OCR = {
    "type": "object",
    "properties": {
        "languages": {
            "type": "array",
            "items": {"type": "string", "minLength": 2, "maxLength": 8},
            "minItems": 1,
            "maxItems": 5,
        },
        "deskew": {"type": "boolean"},
        "rotate_pages": {"type": "boolean"},
        "clean": {"type": "boolean"},
        # Re-OCR pages that already have text. Off by default so a born-digital
        # PDF never has its real text layer replaced by a guess at a picture.
        "force": {"type": "boolean"},
    },
    "additionalProperties": False,
}

CONVERT_TO = {
    "type": "object",
    "required": ["format"],
    "properties": {
        "format": {"enum": ["docx", "images", "txt", "md", "html", "pdfa"]},
        "dpi": {"type": "integer", "minimum": 72, "maximum": 300},
        "image_format": {"enum": ["png", "jpg"]},
    },
    "additionalProperties": False,
}

CONVERT_FROM = {
    "type": "object",
    "properties": {
        # Exactly one source: an uploaded file (by ref) or a web address.
        "upload_ref": {"type": "string", "minLength": 1, "maxLength": 200},
        # Several images → one PDF, a page each. `/jpg-to-pdf` promises this in
        # so many words; one job per file gave N separate documents instead.
        "upload_refs": {
            "type": "array",
            "items": {"type": "string", "minLength": 1, "maxLength": 200},
            "minItems": 1,
            "maxItems": 100,
        },
        "filename": {"type": "string", "minLength": 1, "maxLength": 255},
        "url": {"type": "string", "minLength": 1, "maxLength": 2000},
        "fit": {"enum": ["a4", "original"]},
    },
    "additionalProperties": False,
}

COMPARE = {
    "type": "object",
    "required": ["other_document_id"],
    "properties": {
        "other_document_id": {"type": "string", "minLength": 1, "maxLength": 64},
        # Index-based alignment with a manual offset (phase-06 v1).
        "offset": {"type": "integer", "minimum": -500, "maximum": 500},
        "visual": {"type": "boolean"},
    },
    "additionalProperties": False,
}

REPAIR = {
    "type": "object",
    "properties": {},
    "additionalProperties": False,
}


# --------------------------------------------------------------------------- #
# Phase 7 — security & redaction
# --------------------------------------------------------------------------- #
_PERMISSIONS = {
    "type": "object",
    "properties": {
        "print": {"enum": ["none", "lowres", "full"]},
        "copy": {"type": "boolean"},
        "modify": {"enum": ["none", "form_fill", "annotate", "full"]},
        # Accepted so a client can round-trip the read model, but the engine
        # always allows it: a PDF a screen reader cannot read excludes its user
        # for no security gain (§17, phase-07).
        "accessibility": {"type": "boolean"},
    },
    "additionalProperties": False,
}

# Passwords travel in params and are redacted from every API response and
# dropped from the row when the job finishes — see `Job.SENSITIVE_PARAMS`. The
# *session* password is not here: it is a sibling of `params` on the request
# (`OperationRequestSerializer.document_password`), because it belongs to the
# document rather than to any one operation. A proper secrets channel is
# backlog; this is the documented tradeoff (phase-07).
_PASSWORD = {"type": "string", "minLength": 1, "maxLength": 256}

ENCRYPT = {
    "type": "object",
    "required": ["owner_password"],
    "properties": {
        "owner_password": _PASSWORD,
        "user_password": {"type": "string", "maxLength": 256},
        "permissions": _PERMISSIONS,
    },
    "additionalProperties": False,
}

DECRYPT = {
    "type": "object",
    "properties": {
        "password": {"type": "string", "maxLength": 256},
    },
    "additionalProperties": False,
}

SET_PERMISSIONS = {
    "type": "object",
    "required": ["owner_password", "permissions"],
    "properties": {
        "owner_password": _PASSWORD,
        "user_password": {"type": "string", "maxLength": 256},
        "permissions": _PERMISSIONS,
    },
    "additionalProperties": False,
}

REDACT = {
    "type": "object",
    "properties": {
        "areas": {
            "type": "array",
            "maxItems": 500,
            "items": {
                "type": "object",
                "required": ["page", "rect"],
                "properties": {"page": {"type": "integer", "minimum": 0},
                               "rect": _NORM_RECT},
                "additionalProperties": False,
            },
        },
        "patterns": {
            "type": "array",
            "maxItems": 20,
            "items": {
                "type": "object",
                "required": ["kind", "value"],
                "properties": {
                    "kind": {"enum": ["preset", "regex"]},
                    "value": {"type": "string", "minLength": 1, "maxLength": 500},
                },
                "additionalProperties": False,
            },
        },
        "search_text": {"type": "string", "minLength": 1, "maxLength": 500},
        "match_case": {"type": "boolean"},
        "scope": {"type": "array", "items": {"type": "integer", "minimum": 0},
                  "maxItems": 5000},
        "fill": {
            "type": "object",
            "properties": {
                "color": {"type": "string", "maxLength": 32},
                "label": {"type": "string", "maxLength": 64},
            },
            "additionalProperties": False,
        },
        # Which dry-run matches to apply, by id — the review list's unticked
        # rows are how a user says "not that one" (same shape as find_replace).
        "only": {"type": "array", "items": {"type": "string", "maxLength": 64},
                 "maxItems": 5000},
        "dry_run": {"type": "boolean"},
        # A redacted document whose *previous version* still holds the content
        # is not redacted. On by default in the UI (phase-07).
        "fork_clean_copy": {"type": "boolean"},
    },
    "additionalProperties": False,
}

SANITIZE = {
    "type": "object",
    "properties": {
        "metadata": {"type": "boolean"},
        "xmp": {"type": "boolean"},
        "javascript": {"type": "boolean"},
        "embedded_files": {"type": "boolean"},
        "hidden_layers_flatten": {"type": "boolean"},
        "links_external": {"type": "boolean"},
        "comments": {"type": "boolean"},
    },
    "additionalProperties": False,
}


# --------------------------------------------------------------------------- #
# Phase 8 — e-signatures
# --------------------------------------------------------------------------- #
SELF_SIGN = {
    "type": "object",
    "required": ["placements"],
    "properties": {
        "placements": {
            "type": "array",
            "minItems": 1,
            "maxItems": 100,
            "items": {
                "type": "object",
                "required": ["page", "rect"],
                "properties": {
                    "page": {"type": "integer", "minimum": 0},
                    "rect": _NORM_RECT,
                    # One of the two, checked in the engine rather than here:
                    # `signature_id` is a saved signature (account-only), and
                    # `signature_upload_ref` is an ephemeral upload, **which is
                    # how a guest signs** (§21.3, the Phase-2B gate).
                    "signature_id": {"type": "string", "maxLength": 64},
                    "signature_upload_ref": {"type": "string", "maxLength": 64},
                },
                "additionalProperties": False,
            },
        },
        "include_date": {"type": "boolean"},
    },
    "additionalProperties": False,
}
