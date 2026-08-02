"""Encryption, permissions and sanitization (phase-07; §10, §17).

Encryption is pikepdf's, which is qpdf's: AES-256 with revision 6, the only
scheme in the PDF spec that is not trivially strippable. Two passwords with
different jobs:

* **user password** — needed to *open* the document. Optional: a document with
  only an owner password opens for anyone and merely asks readers to respect
  its permissions.
* **owner password** — needed to *change* the restrictions. Required, because a
  permission set nobody can lift is a document its author cannot recover.

One permission is never restricted: **accessibility**. A screen reader is not a
threat model, and a PDF that a blind user cannot read is a PDF that excludes
them for no security gain — the "copy" restriction it would ride along with is
advisory anyway.
"""
from __future__ import annotations

import contextlib
import io

import fitz

from ..exceptions import DocumentEncryptedError, EngineError, InvalidParams

PRINT_LEVELS = ("none", "lowres", "full")
MODIFY_LEVELS = ("none", "form_fill", "annotate", "full")


def _open_pikepdf(data: bytes, password: str = ""):
    import pikepdf

    try:
        return pikepdf.open(io.BytesIO(data), password=password or "",
                            allow_overwriting_input=False)
    except pikepdf.PasswordError as exc:
        raise EngineError(
            "That password did not open this document.", code="invalid_password",
        ) from exc
    except Exception as exc:  # noqa: BLE001
        raise EngineError(f"Could not open PDF: {exc}", code="unsupported_file") from exc


def is_encrypted(data: bytes) -> bool:
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        return bool(doc.needs_pass or doc.is_encrypted)
    finally:
        doc.close()


def _permissions(spec: dict | None):
    """The §10 permission set → pikepdf's `Permissions`.

    Accessibility is hard-wired on. Everything else is the caller's choice, with
    the two graded ones (print, modify) mapped onto the flags the PDF spec
    actually has rather than onto a boolean that would lose the distinction.
    """
    import pikepdf

    spec = spec or {}
    print_level = str(spec.get("print", "full"))
    modify_level = str(spec.get("modify", "full"))
    if print_level not in PRINT_LEVELS:
        raise InvalidParams(f"`print` must be one of {list(PRINT_LEVELS)}")
    if modify_level not in MODIFY_LEVELS:
        raise InvalidParams(f"`modify` must be one of {list(MODIFY_LEVELS)}")

    return pikepdf.Permissions(
        accessibility=True,
        extract=bool(spec.get("copy", True)),
        print_lowres=print_level in {"lowres", "full"},
        print_highres=print_level == "full",
        modify_other=modify_level == "full",
        modify_assembly=modify_level == "full",
        modify_annotation=modify_level in {"annotate", "full"},
        modify_form=modify_level in {"form_fill", "annotate", "full"},
    )


def encrypt(data: bytes, *, owner_password: str, user_password: str = "",
            permissions: dict | None = None, password: str = "") -> bytes:
    """Encrypt with AES-256. `password` opens an already-encrypted input."""
    import pikepdf

    if not owner_password:
        raise InvalidParams(
            "An owner password is required — without one the restrictions "
            "could never be lifted again."
        )
    pdf = _open_pikepdf(data, password)
    try:
        buf = io.BytesIO()
        pdf.save(buf, encryption=pikepdf.Encryption(
            user=user_password or "", owner=owner_password, R=6,
            allow=_permissions(permissions),
        ))
        return buf.getvalue()
    finally:
        pdf.close()


def decrypt(data: bytes, *, password: str = "") -> bytes:
    """Remove encryption entirely. Wrong password → `invalid_password`."""
    if not is_encrypted(data):
        raise InvalidParams("This document is not password-protected.")
    pdf = _open_pikepdf(data, password)
    try:
        buf = io.BytesIO()
        pdf.save(buf)
        return buf.getvalue()
    finally:
        pdf.close()


def set_permissions(data: bytes, *, permissions: dict, owner_password: str,
                    user_password: str = "", password: str = "") -> bytes:
    """Re-encrypt with a new permission set. Needs the owner password."""
    return encrypt(data, owner_password=owner_password,
                   user_password=user_password, permissions=permissions,
                   password=password)


def read_permissions(data: bytes, *, password: str = "") -> dict:
    """What the file currently allows, in the §10 vocabulary."""
    pdf = _open_pikepdf(data, password)
    try:
        if not pdf.is_encrypted:
            return {"encrypted": False}
        allow = pdf.allow
        print_level = ("full" if allow.print_highres
                       else "lowres" if allow.print_lowres else "none")
        modify_level = ("full" if allow.modify_other
                        else "annotate" if allow.modify_annotation
                        else "form_fill" if allow.modify_form else "none")
        return {
            "encrypted": True,
            "print": print_level,
            "copy": bool(allow.extract),
            "modify": modify_level,
            "accessibility": bool(allow.accessibility),
        }
    finally:
        pdf.close()


# --------------------------------------------------------------------------- #
# Sanitize
# --------------------------------------------------------------------------- #
SANITIZE_ITEMS = ("metadata", "xmp", "javascript", "embedded_files",
                  "hidden_layers_flatten", "links_external", "comments")


def sanitize(data: bytes, *, password: str = "", **options) -> tuple[bytes, dict]:
    """Strip the things a document carries that its author did not mean to send.

    Every item is opt-in and reported by count, because "sanitized" with no
    detail is a claim: a user who is about to send a contract wants to know
    whether it *had* a script in it, not merely that it does not now.
    """
    import pikepdf

    wanted = {name: bool(options.get(name, False)) for name in SANITIZE_ITEMS}
    if not any(wanted.values()):
        raise InvalidParams("Choose at least one thing to remove.")

    report = {name: 0 for name in SANITIZE_ITEMS}
    pdf = _open_pikepdf(data, password)
    try:
        root = pdf.Root

        if wanted["metadata"]:
            if pdf.docinfo and len(pdf.docinfo.keys()):
                report["metadata"] = len(pdf.docinfo.keys())
            with pdf.open_metadata() as meta:
                meta.load_from_docinfo(pikepdf.Dictionary())
            del pdf.docinfo

        if wanted["xmp"] and "/Metadata" in root:
            del root["/Metadata"]
            report["xmp"] = 1

        if wanted["javascript"]:
            report["javascript"] = _strip_javascript(pdf)

        if wanted["embedded_files"]:
            report["embedded_files"] = _strip_embedded_files(pdf)

        if wanted["hidden_layers_flatten"]:
            report["hidden_layers_flatten"] = _flatten_layers(pdf)

        if wanted["links_external"] or wanted["comments"]:
            report["links_external"], report["comments"] = _strip_annotations(
                pdf, links=wanted["links_external"], comments=wanted["comments"],
            )

        pdf.remove_unreferenced_resources()
        buf = io.BytesIO()
        pdf.save(buf, linearize=False)
        out = buf.getvalue()
    finally:
        pdf.close()

    # Unlinking an object is not deleting it: qpdf keeps orphans, so a comment
    # removed from `/Annots` was still sitting in the file for anyone reading
    # the raw bytes. `garbage=4` is the pass that actually collects them, and
    # "sanitized" has to mean the content is gone, not merely unreferenced.
    out = _compact(out)

    report["total"] = sum(report[name] for name in SANITIZE_ITEMS)
    return out, report


def _compact(data: bytes) -> bytes:
    """Full object garbage-collection, so removed content leaves the bytes."""
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        return doc.tobytes(garbage=4, deflate=True, clean=True)
    finally:
        doc.close()


def _strip_javascript(pdf) -> int:
    """Document-level JavaScript, `/OpenAction` and every additional-action.

    Three separate hiding places, and a file that only had one cleaned is a
    file that still runs on open.
    """
    removed = 0
    root = pdf.Root

    if "/OpenAction" in root:
        del root["/OpenAction"]
        removed += 1
    if "/AA" in root:
        del root["/AA"]
        removed += 1

    names = root.get("/Names")
    if names is not None and "/JavaScript" in names:
        tree = names["/JavaScript"]
        entries = tree.get("/Names")
        removed += (len(entries) // 2) if entries is not None else 1
        del names["/JavaScript"]

    for page in pdf.pages:
        if "/AA" in page:
            del page["/AA"]
            removed += 1
        for annot in list(page.get("/Annots") or []):
            action = annot.get("/A")
            if action is not None and str(action.get("/S", "")) == "/JavaScript":
                del annot["/A"]
                removed += 1
            if "/AA" in annot:
                del annot["/AA"]
                removed += 1
    return removed


def _strip_embedded_files(pdf) -> int:
    root = pdf.Root
    removed = 0
    names = root.get("/Names")
    if names is not None and "/EmbeddedFiles" in names:
        entries = names["/EmbeddedFiles"].get("/Names")
        removed += (len(entries) // 2) if entries is not None else 1
        del names["/EmbeddedFiles"]
    # File attachment annotations carry their own copy.
    for page in pdf.pages:
        keep = []
        for annot in list(page.get("/Annots") or []):
            if str(annot.get("/Subtype", "")) == "/FileAttachment":
                removed += 1
                continue
            keep.append(annot)
        _set_annots(pdf, page, keep)
    return removed


def _flatten_layers(pdf) -> int:
    """**Delete** the content of layers that are switched off, then drop the
    layer machinery.

    A hidden layer is content the reader cannot see and the file still carries —
    the most common way a "redacted" document turns out not to be. The obvious
    implementation (drop `/OCProperties` and let everything render) does the
    opposite of what the checklist promises: it takes the content the user
    asked to have *removed* and prints it on the page. So the off layers'
    marked-content sections are cut out of the page streams first, and only
    then is the machinery dropped from what is left.
    """
    root = pdf.Root
    ocproperties = root.get("/OCProperties")
    if ocproperties is None:
        return 0
    groups = ocproperties.get("/OCGs") or []
    default = ocproperties.get("/D")
    off = {_ident(g) for g in ((default or {}).get("/OFF") or [])}

    removed = 0
    if off:
        for page in pdf.pages:
            removed += _cut_hidden_content(pdf, page, off)

    del root["/OCProperties"]
    for page in pdf.pages:
        resources = page.get("/Resources")
        if resources is not None and "/Properties" in resources:
            del resources["/Properties"]
        for annot in list(page.get("/Annots") or []):
            if "/OC" in annot:
                del annot["/OC"]
    # Report the groups that were actually *hidden*; a visible layer being
    # flattened is not something removed from the document.
    return removed if off else 0 if groups else 0


def _cut_hidden_content(pdf, page, off: set) -> int:
    """Remove `/OC …BDC … EMC` sections belonging to an off group."""
    import pikepdf

    resources = page.get("/Resources")
    properties = (resources or {}).get("/Properties") or {}
    hidden_tags = {
        str(name) for name, value in properties.items() if _is_off(value, off)
    }
    xobjects = (resources or {}).get("/XObject") or {}
    hidden_xobjects = {
        str(name) for name, value in xobjects.items()
        if "/OC" in value and _is_off(value.get("/OC"), off)
    }
    if not hidden_tags and not hidden_xobjects:
        return 0

    try:
        instructions = pikepdf.parse_content_stream(page)
    except Exception:  # noqa: BLE001 - a stream we cannot parse is left alone
        return 0

    kept: list = []
    depth = 0
    dropping_at = 0
    removed = 0
    # pikepdf yields instructions that unpack as `(operands, operator)`;
    # its stub omits `__iter__`, so the checker cannot see that.
    for operands, operator in instructions:  # type: ignore[misc]
        op = str(operator)
        if op in {"BDC", "BMC"}:
            depth += 1
            if not dropping_at and op == "BDC" and len(operands) >= 2 \
                    and str(operands[0]) == "/OC" and str(operands[1]) in hidden_tags:
                dropping_at = depth
                removed += 1
                continue
        if dropping_at:
            if op == "EMC":
                closing = depth
                depth -= 1
                if closing == dropping_at:
                    dropping_at = 0
            continue
        if op == "EMC":
            depth -= 1
        if op == "Do" and operands and str(operands[0]) in hidden_xobjects:
            removed += 1
            continue
        kept.append((operands, operator))

    page.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
    for name in hidden_xobjects:
        with contextlib.suppress(KeyError):
            del xobjects[name]
    return removed


def _is_off(value, off: set) -> bool:
    """True when this OC reference resolves to a group that is switched off."""
    if value is None:
        return False
    if _ident(value) in off:
        return True
    # An /OCMD wraps one or more groups; hidden if any of them is.
    members = value.get("/OCGs") if hasattr(value, "get") else None
    if members is None:
        return False
    if _ident(members) in off:
        return True
    try:
        return any(_ident(g) in off for g in members)
    except TypeError:  # pragma: no cover - a single indirect group
        return False


def _strip_annotations(pdf, *, links: bool, comments: bool) -> tuple[int, int]:
    removed_links = 0
    removed_comments = 0
    for page in pdf.pages:
        annots = list(page.get("/Annots") or [])
        doomed = set()

        for annot in annots:
            subtype = str(annot.get("/Subtype", ""))
            if subtype == "/Link" and links:
                # An internal jump is navigation, not a tracker; only outbound
                # URIs are stripped.
                action = annot.get("/A")
                if action is not None and str(action.get("/S", "")) == "/URI":
                    removed_links += 1
                    doomed.add(_ident(annot))
                continue
            if comments and subtype not in {"/Link", "/Widget", "/Popup"}:
                removed_comments += 1
                doomed.add(_ident(annot))

        # A note's `/Popup` holds a reference back to it, so removing only the
        # note left the object — and its text — alive in the file. "Removed"
        # has to mean the bytes are gone, which is what the caller will check.
        if comments:
            for annot in annots:
                parent = annot.get("/Parent")
                if str(annot.get("/Subtype", "")) == "/Popup" and parent is not None \
                        and _ident(parent) in doomed:
                    doomed.add(_ident(annot))

        keep = [a for a in annots if _ident(a) not in doomed]
        _set_annots(pdf, page, keep)
    return removed_links, removed_comments


def _ident(obj):
    """Object identity that survives repeated `get()` calls."""
    try:
        return obj.objgen
    except AttributeError:  # pragma: no cover - direct (inline) object
        return id(obj)


def _set_annots(pdf, page, annots) -> None:
    import pikepdf

    if annots:
        page.Annots = pikepdf.Array(annots)
    elif "/Annots" in page:
        del page["/Annots"]


def open_with_password(data: bytes, password: str = "") -> bytes:
    """Decrypted bytes for an engine that cannot take a password.

    Every other engine module assumes it is handed a readable PDF. Rather than
    teach fifteen of them about passwords, the worker unlocks once, here, and
    the rest of the pipeline never knows.
    """
    if not is_encrypted(data):
        return data
    if not password:
        raise DocumentEncryptedError(
            "This document is password-protected. Unlock it to continue."
        )
    return decrypt(data, password=password)
