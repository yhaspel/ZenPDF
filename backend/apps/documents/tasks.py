"""Job worker pipeline (01-architecture.md §11, §12, §14).

Every mutation: acquire doc lock → refetch → base_version_seq guard → download →
pure engine fn → measure → upload new version blob → create immutable version →
advance document. On any exception the document is untouched (versions immutable).
"""
from __future__ import annotations

import contextlib
import hashlib
import logging

from celery import shared_task
from django.conf import settings

from apps.core import limits as L
from apps.core.principals import (
    created_by_user,
    is_guest,
    owned_by,
    owner_kwargs,
    principal_of,
)
from apps.jobs.models import Job
from apps.pdf_engine import registry
from apps.pdf_engine.engine import annotations as A
from apps.pdf_engine.engine import compare as CMP
from apps.pdf_engine.engine import content as C
from apps.pdf_engine.engine import convert as CV
from apps.pdf_engine.engine import forms as F
from apps.pdf_engine.engine import ocr as O
from apps.pdf_engine.engine import pages as P
from apps.pdf_engine.engine import redact as RD
from apps.pdf_engine.engine import render as R
from apps.pdf_engine.engine import security as SEC
from apps.pdf_engine.exceptions import EngineError
from apps.pdf_engine.storage import get_storage

from .models import Document, DocumentVersion

logger = logging.getLogger(__name__)

THUMB_PAGES = 20
THUMB_WIDTH = 240


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
@contextlib.contextmanager
def doc_lock(document_id: str):
    """Blocking Redis lock `zen:doc:{id}` (§11). No-op under eager tests."""
    if getattr(settings, "CELERY_TASK_ALWAYS_EAGER", False):
        yield
        return
    import redis

    client = redis.from_url(settings.REDIS_URL)
    lock = client.lock(
        f"zen:doc:{document_id}",
        timeout=settings.DOC_LOCK_TIMEOUT,
        blocking_timeout=settings.DOC_LOCK_TIMEOUT,
    )
    acquired = lock.acquire()
    try:
        yield
    finally:
        if acquired:
            with contextlib.suppress(Exception):
                lock.release()


def _canceled(job: Job) -> bool:
    """Cooperative-cancel checkpoint: re-read the row the API may have updated."""
    return Job.objects.filter(pk=job.pk, status=Job.Status.CANCELED).exists()


def _measure(data: bytes) -> tuple[str, int, int]:
    import fitz

    sha = hashlib.sha256(data).hexdigest()
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        pages = doc.page_count
    finally:
        doc.close()
    return sha, pages, len(data)


def _version_bytes(version: DocumentVersion) -> bytes:
    return get_storage().get_bytes(version.storage_key)


def _source_document(job: Job, doc_id) -> Document:
    """Re-check ownership of a *source* document inside the worker (§21.2).

    Scoped through `owned_by(..., principal_of(job))`. The pre-2B spelling —
    `Document.objects.get(id=…, owner=job.user)` — becomes `owner_id IS NULL`
    for a guest job, matching any guest's document with that id.
    """
    return owned_by(Document.objects.all(), principal_of(job)).get(id=doc_id)


def _create_document_from_bytes(*, principal, folder, title, data, created_by, job,
                                label="Original"):
    from .services import guest_expiry

    sha, pages, size = _measure(data)
    # The tier page cap, enforced on *every* route into the library. Ingest
    # checks it (`services.ingest_pdf`); this is the other door, and it was
    # open: a 2 000-frame TIFF is a 288 KB upload and a 2 000-page document,
    # which sails past a guest's 300-page limit and then multiplies the cost of
    # every operation run on it afterwards (§16, §17).
    limits = L.for_principal(principal)
    if pages > limits.max_pages:
        raise EngineError(
            f"That would produce a {pages}-page document; the limit is "
            f"{limits.max_pages}."
            + (" Create a free account to work with larger documents."
               if is_guest(principal) else ""),
            code="validation_error",
            details={"pages": pages, "max_pages": limits.max_pages,
                     "tier": limits.tier},
        )

    doc = Document.objects.create(
        **owner_kwargs(principal),
        expires_at=guest_expiry() if is_guest(principal) else None,
        folder=folder, title=title[:255], status=Document.Status.PROCESSING,
    )
    key = f"docs/{doc.id}/v1.pdf"
    get_storage().put_bytes(key, data)
    doc.record_version(
        storage_key=key, size_bytes=size, page_count=pages, sha256=sha,
        label=label, created_by=created_by, job=job, seq=1,
    )
    L.bump_storage(principal, size)
    generate_thumbnails_task.delay(str(doc.id), 1, min(pages, THUMB_PAGES), THUMB_WIDTH)
    return doc


def _save_new_version(*, document, data, label, created_by, job):
    sha, pages, size = _measure(data)
    seq = document.next_version_seq()
    key = f"docs/{document.id}/v{seq}.pdf"
    get_storage().put_bytes(key, data)
    version = document.record_version(
        storage_key=key, size_bytes=size, page_count=pages, sha256=sha,
        label=label, created_by=created_by, job=job, seq=seq,
    )
    L.bump_storage(document.principal, size)
    generate_thumbnails_task.delay(str(document.id), seq, min(pages, THUMB_PAGES), THUMB_WIDTH)
    return version


def _save_export(job: Job, payload: dict) -> dict:
    """Store an export artefact at `exports/{job_id}/{filename}` (§13, §15).

    Metered against the principal's storage like every other write: a 300-DPI
    image export of a long document is bigger than the document, and an
    unmetered namespace is a quota hole with a download button on it.
    """
    key = f"exports/{job.id}/{payload['filename']}"
    get_storage().put_bytes(key, payload["data"], content_type=payload["content_type"])
    L.bump_storage(principal_of(job), len(payload["data"]))
    return {
        "filename": payload["filename"],
        "content_type": payload["content_type"],
        "size_bytes": len(payload["data"]),
        "storage_key": key,
    }


def _clean_copy_title(job) -> str:
    base = getattr(getattr(job, "document", None), "title", "") or "Document"
    return f"{base} (redacted)"[:255]


def _author_of(job: Job) -> str:
    """The annotation author to embed in the file (phase-03 §3).

    A guest has no display name, and the session id / IP must never reach a file
    the user is about to share — so a guest is simply "Guest".
    """
    principal = principal_of(job)
    if principal is None or is_guest(principal):
        return "Guest"
    return (getattr(principal, "display_name", "") or "").strip() or "You"


def _annotation_images(job: Job, params: dict) -> dict[str, bytes]:
    """Resolve `image_ref`s in an annotate batch to bytes, scoped to the job's
    principal — the key is derived from the principal, so a ref can never reach
    another principal's asset (§13, `core.assets`)."""
    refs = [
        (op.get("annotation") or {}).get("image_ref")
        for op in (params.get("ops") or [])
    ]
    return _load_images(job, [r for r in refs if r])


def _load_images(job: Job, refs) -> dict[str, bytes]:
    from apps.core.assets import load_images

    refs = [r for r in refs if r]
    if not refs:
        return {}
    return load_images(principal_of(job), refs)


def _one_image(job: Job, ref) -> bytes:
    """The single uploaded image an op needs, or a validation error naming it."""
    images = _load_images(job, [ref])
    data = images.get(str(ref or ""))
    if not data:
        raise EngineError(f"Image '{ref}' was not found. Upload it again.")
    return data


def _apply_single(op, primary_bytes, params, source_bytes, *, job=None):
    """Return (kind, payload, label, report).

    kind ∈ {version, documents, **report**}. `report` is inspection only — a
    find & replace dry run changes no bytes, so it must not mint a version.
    """
    t = op.type
    if t == "rotate_pages":
        data = P.rotate_pages(primary_bytes, pages=params["pages"], degrees=params["degrees"])
        return "version", data, f"Rotated {len(params['pages'])} page(s)", None
    if t == "delete_pages":
        data = P.delete_pages(primary_bytes, pages=params["pages"])
        return "version", data, f"Deleted {len(params['pages'])} page(s)", None
    if t == "duplicate_pages":
        data = P.duplicate_pages(primary_bytes, pages=params["pages"])
        return "version", data, f"Duplicated {len(params['pages'])} page(s)", None
    if t == "reorder_pages":
        data = P.reorder_pages(primary_bytes, new_order=params["new_order"])
        return "version", data, "Reordered pages", None
    if t == "insert_blank":
        data = P.insert_blank(primary_bytes, at_index=params["at_index"],
                              count=params.get("count", 1), size=params.get("size", "a4"))
        return "version", data, f"Inserted {params.get('count', 1)} blank page(s)", None
    if t == "insert_from_document":
        data = P.insert_from_document(primary_bytes, source_bytes[0],
                                      source_pages=params.get("source_pages"),
                                      at_index=params["at_index"])
        return "version", data, "Inserted pages", None
    if t == "crop_pages":
        data = P.crop_pages(primary_bytes, pages=params["pages"], rect=params["rect"])
        return "version", data, f"Cropped {len(params['pages'])} page(s)", None
    if t == "scale_pages":
        data = P.scale_pages(primary_bytes, pages=params["pages"],
                             target_size=params.get("target_size", "a4"))
        return "version", data, f"Scaled {len(params['pages'])} page(s)", None
    if t == "nup":
        data = P.nup(primary_bytes, per_sheet=params.get("per_sheet", 2),
                     page_size=params.get("page_size", "a4"))
        return "version", data, f"{params.get('per_sheet', 2)}-up layout", None
    if t == "compress":
        data, report = P.compress(primary_bytes, preset=params.get("preset", "balanced"),
                                  image_dpi=params.get("image_dpi", 150))
        pct = report.get("note") or f"-{int(report['ratio'] * 100)}%"
        return "version", data, f"Compressed ({pct})", report
    if t == "extract_pages":
        data = P.extract_pages(primary_bytes, pages=params["pages"])
        if params.get("as_new_document"):
            return "documents", [{"data": data, "title": "Extracted pages"}], "Extracted", None
        return "version", data, f"Extracted {len(params['pages'])} page(s)", None
    if t == "split":
        items = P.split(primary_bytes, mode=params["mode"], ranges=params.get("ranges", ""),
                        every_n=params.get("every_n", 1), max_mb=params.get("max_mb", 5.0),
                        base_title=params.get("base_title", "Document"))
        return "documents", items, "Split", None
    if t == "annotate_batch":
        data, report = A.apply_annotation_ops(
            primary_bytes,
            ops=params["ops"],
            author=_author_of(job) if job is not None else "Guest",
            images=_annotation_images(job, params) if job is not None else {},
        )
        touched = report["added"] + report["updated"] + report["deleted"]
        return "version", data, f"Annotated ({touched} change(s))", report
    if t == "flatten":
        what = params.get("what", "annotations")
        data = A.flatten_annotations(primary_bytes, what=what)
        label = {"annotations": "Flattened annotations", "form": "Flattened form",
                 "all": "Flattened"}[what]
        return "version", data, label, None

    # --- Phase 4: content editing ------------------------------------- #
    if t == "edit_text":
        data = C.edit_text(primary_bytes, edits=params["edits"])
        return "version", data, f"Edited text ({len(params['edits'])} block(s))", None
    if t == "add_text":
        data = C.add_text(primary_bytes, boxes=params["boxes"])
        return "version", data, f"Added text ({len(params['boxes'])} box(es))", None
    if t == "whiteout":
        data = C.whiteout(primary_bytes, rects=params["rects"],
                          color=params.get("color"))
        return "version", data, f"Whiteout ({len(params['rects'])} area(s))", None
    if t == "find_replace":
        data, report = C.find_replace(
            primary_bytes, find=params["find"], replace=params.get("replace", ""),
            match_case=params.get("match_case", False), pages=params.get("pages"),
            dry_run=params.get("dry_run", False), only=params.get("only"),
        )
        if data is None:
            # A dry run inspects the document and changes nothing, so it must
            # not mint a version — the review UI is a read, expressed as a job
            # only because the search runs on the worker.
            return "report", report, "", report
        return "version", data, f"Replaced {report['replaced']} match(es)", report
    if t == "add_image":
        data = C.add_image(primary_bytes, page=params["page"], rect=params["rect"],
                           image=_one_image(job, params["image_ref"]),
                           keep_aspect=params.get("keep_aspect", True))
        return "version", data, "Added image", None
    if t == "replace_image":
        data = C.replace_image(primary_bytes, page=params["page"], xref=params["xref"],
                               image=_one_image(job, params["image_ref"]))
        return "version", data, "Replaced image", None
    if t == "delete_image":
        data = C.delete_image(primary_bytes, page=params["page"], xref=params["xref"])
        return "version", data, "Deleted image", None
    if t == "add_link":
        data = C.add_link(primary_bytes, **params)
        return "version", data, "Added link", None
    if t == "edit_link":
        data = C.edit_link(primary_bytes, **params)
        return "version", data, "Edited link", None
    if t == "delete_link":
        data = C.delete_link(primary_bytes, page=params["page"], index=params["index"])
        return "version", data, "Deleted link", None
    if t == "header_footer":
        data = C.header_footer(primary_bytes, **params)
        return "version", data, "Header/footer", None
    if t == "page_numbers":
        data = C.page_numbers(primary_bytes, **params)
        return "version", data, "Page numbers", None
    if t == "bates":
        data, report = C.bates(primary_bytes, **params)
        return "version", data, f"Bates {report['first']}–{report['last']}", report
    if t == "watermark":
        # Copy: `params` *is* `job.params`, and popping from it would rewrite the
        # job's own record of what was asked for.
        params = dict(params)
        image_ref = params.pop("image_ref", None)
        data = C.watermark(
            primary_bytes,
            image=_one_image(job, image_ref) if image_ref else None,
            **params,
        )
        return "version", data, "Watermark", None
    if t == "overlay_pdf":
        data = C.overlay_pdf(
            primary_bytes, source_bytes[0], mode=params.get("mode", "foreground"),
            range=params.get("range"), overlay_page=params.get("overlay_page", 0),
        )
        return "version", data, "Overlay applied", None
    if t == "set_metadata":
        data = C.set_metadata(primary_bytes, **params)
        return "version", data, "Metadata updated", None
    if t == "set_bookmarks":
        data = C.set_bookmarks(primary_bytes, toc=params["toc"])
        return "version", data, f"Bookmarks ({len(params['toc'])})", None

    # --- Phase 5: forms ------------------------------------------------ #
    if t == "fill_form":
        data, report = F.fill_form(primary_bytes, values=params["values"],
                                   flatten_after=params.get("flatten_after", False))
        label = "Form filled" + (" and flattened" if report["flattened"] else "")
        return "version", data, label, report
    if t == "edit_form_fields_batch":
        data, report = F.edit_fields_batch(primary_bytes, ops=params["ops"])
        touched = report["added"] + report["updated"] + report["deleted"]
        return "version", data, f"Form edited ({touched} field(s))", report
    if t == "import_form_data":
        values = F.parse_form_data(params["data"].encode(), fmt=params["format"])
        if not values:
            raise EngineError("That file contained no field values.")
        data, report = F.fill_form(primary_bytes, values=values,
                                   flatten_after=params.get("flatten_after", False))
        return "version", data, f"Form data imported ({report['filled']} field(s))", report

    # --- Phase 6: OCR, conversion, compare, repair --------------------- #
    if t == "ocr":
        data, report = O.ocr(
            primary_bytes,
            languages=params.get("languages"),
            deskew=params.get("deskew", False),
            rotate_pages=params.get("rotate_pages", False),
            clean=params.get("clean", False),
            force=params.get("force", False),
        )
        # Counted where the work happened, so the monthly figure reflects pages
        # actually processed rather than pages requested (phase-06 Backend).
        if job is not None:
            L.record_ocr_pages(principal_of(job), report["pages"])
        langs = "+".join(report["languages"])
        return "version", data, f"OCR ({langs})", report
    if t == "repair":
        from apps.pdf_engine.engine.validate import repair_pdf

        data = repair_pdf(primary_bytes)
        return "version", data, "Repaired", None
    if t == "compare":
        report = CMP.compare(primary_bytes, source_bytes[0],
                             offset=params.get("offset", 0),
                             visual=params.get("visual", True))
        return "report", report, "Compared", report
    if t == "convert_to":
        blob, filename, content_type, report = CV.convert_to(
            primary_bytes,
            target=params["format"],
            dpi=params.get("dpi", 150),
            image_format=params.get("image_format", "png"),
        )
        return "export", {"data": blob, "filename": filename,
                          "content_type": content_type}, f"Exported {params['format']}", report

    # --- Phase 7: security & redaction ---------------------------------- #
    if t == "encrypt":
        data = SEC.encrypt(
            primary_bytes,
            owner_password=params["owner_password"],
            user_password=params.get("user_password", ""),
            permissions=params.get("permissions"),
        )
        return "version", data, "Protected", {"encrypted": True}
    if t == "decrypt":
        data = SEC.decrypt(primary_bytes,
                           password=params.get("password")
                           or params.get("document_password", ""))
        return "version", data, "Unlocked", {"encrypted": False}
    if t == "set_permissions":
        data = SEC.set_permissions(
            primary_bytes,
            permissions=params["permissions"],
            owner_password=params["owner_password"],
            user_password=params.get("user_password", ""),
        )
        return "version", data, "Permissions updated", {"encrypted": True}
    if t == "sanitize":
        data, report = SEC.sanitize(primary_bytes, **{
            k: v for k, v in params.items() if k in SEC.SANITIZE_ITEMS
        })
        return "version", data, f"Sanitized ({report['total']} item(s))", report
    if t == "redact":
        if params.get("dry_run"):
            # Inspection only, like find & replace: a search must not put
            # "Redacted 0 items" in the history.
            report = RD.find_matches(
                primary_bytes,
                patterns=params.get("patterns"),
                search_text=params.get("search_text", ""),
                match_case=params.get("match_case", True),
                scope=params.get("scope"),
            )
            return "report", report, "Reviewed", report
        data, report = RD.redact(
            primary_bytes,
            areas=params.get("areas"),
            patterns=params.get("patterns"),
            search_text=params.get("search_text", ""),
            match_case=params.get("match_case", True),
            scope=params.get("scope"),
            fill=params.get("fill"),
            only=params.get("only"),
        )
        if params.get("fork_clean_copy"):
            # A redacted document whose *earlier version* still contains the
            # content is not redacted. The clean copy has no history at all,
            # which is the only way to say that truthfully (phase-07).
            title = _clean_copy_title(job)
            return "documents", [{"title": title, "data": data}], "Redacted", report
        return "version", data, "Redacted", report
    raise EngineError(f"Unsupported single-document op '{t}'")


# --------------------------------------------------------------------------- #
# Tasks
# --------------------------------------------------------------------------- #
@shared_task(name="apps.documents.tasks.run_operation", bind=True)
def run_operation(self, job_id: str):
    job = Job.objects.select_related("document").get(id=job_id)
    # acks_late redelivers the message when a worker dies; a job that already
    # reached a terminal state must never run twice (§12).
    if job.is_terminal:
        return
    job.celery_task_id = self.request.id or ""
    job.save(update_fields=["celery_task_id"])
    job.mark_running()

    document = job.document
    try:
        # Inside the try: a job that has been marked running and then throws
        # before anything catches it stays `running` for ever, and the client
        # polls a job that will never reach a terminal state. That is exactly
        # what a worker holding a stale registry looked like.
        op = registry.get_op(job.type)
        with doc_lock(str(document.id)):
            document.refresh_from_db()
            current = document.current_version
            if current is None:
                job.mark_failed("not_found", "Document has no current version.")
                return
            if job.base_version_seq is not None and job.base_version_seq != current.seq:
                job.mark_failed("version_conflict",
                                "The document changed since you loaded it.")
                return

            primary_bytes = _version_bytes(current)
            # Every engine module below assumes a readable PDF. Rather than
            # teach fifteen of them about passwords, the document is unlocked
            # here, once — except for `decrypt`, whose whole job is the lock.
            if op.type != "decrypt":
                primary_bytes = SEC.open_with_password(
                    primary_bytes, job.params.get("document_password", "")
                )
            source_bytes = []
            for key in op.source_id_params:
                src_id = job.params.get(key)
                if src_id:
                    src_doc = _source_document(job, src_id)
                    source_bytes.append(_version_bytes(src_doc.current_version))

            kind, payload, label, report = _apply_single(
                op, primary_bytes, job.params, source_bytes, job=job
            )

            # Last point before the result is committed — honour a cancel that
            # arrived while the engine was working.
            if _canceled(job):
                return

            if kind == "report":
                # Inspection only (find & replace dry run): no bytes changed, so
                # no version. Minting one would put "Replaced 0 matches" in the
                # history every time somebody searched.
                #
                # Wrapped in `report` so both halves of the two-step flow answer
                # the same shape — the executed call reports under `report` too,
                # and a client that had to branch on which call it made would be
                # one refactor away from reading the wrong key.
                job.mark_succeeded({"report": payload})
                return

            if kind == "export":
                # A downloadable artefact, not a new version of the document:
                # a Word file or a zip of page images is not a PDF this document
                # could ever advance to (§15, phase-06). It lands under
                # `exports/{job_id}/` and is swept by the 24 h TTL.
                job.mark_succeeded({"export": _save_export(job, payload), **
                                    ({"report": report} if report else {})})
                return

            if kind == "version":
                version = _save_new_version(document=document, data=payload, label=label,
                                            created_by=created_by_user(job), job=job)
                # `encrypt` and `decrypt` change what the *document* is, not
                # just what this version contains — the viewer prompts for a
                # password off this flag.
                if report and "encrypted" in report:
                    document.is_encrypted = bool(report["encrypted"])
                    document.save(update_fields=["is_encrypted"])
                job.mark_succeeded({
                    "document_id": str(document.id),
                    "version_id": str(version.id),
                    "seq": version.seq,
                    **({"report": report} if report else {}),
                })
            else:  # documents
                created = []
                for item in payload:
                    new_doc = _create_document_from_bytes(
                        principal=principal_of(job), folder=document.folder,
                        title=item["title"], data=item["data"],
                        created_by=created_by_user(job), job=job,
                    )
                    created.append(str(new_doc.id))
                job.mark_succeeded({"documents": created})
    except EngineError as exc:
        # `details` carries the structured half of the §6 error shape — e.g.
        # `text_overflow`'s `fits_at_size`, which the editor turns into an offer.
        job.mark_failed(exc.code, exc.message, exc.details)
    except Document.DoesNotExist:
        job.mark_failed("not_found", "A referenced document was not found.")
    except Exception as exc:  # noqa: BLE001
        # Logged as well as recorded on the job: an unexpected exception is an
        # operator problem (a stale worker, a broken dependency), and marking
        # the job failed makes it look like ordinary user-facing validation.
        logger.exception("job %s failed unexpectedly", job.id)
        job.mark_failed("engine_error", f"Operation failed: {exc}")


@shared_task(name="apps.documents.tasks.run_cross_document_operation", bind=True)
def run_cross_document_operation(self, job_id: str):
    """merge / alternate_mix — inputs come entirely from params (§10, /api/operations/)."""
    job = Job.objects.get(id=job_id)
    if job.is_terminal:  # redelivery of an already-finished job (§12)
        return
    job.celery_task_id = self.request.id or ""
    job.save(update_fields=["celery_task_id"])
    job.mark_running()

    try:
        if job.type == "merge":
            ids = job.params["document_ids"]
            docs = [_source_document(job, i) for i in ids]
            datas = [_version_bytes(d.current_version) for d in docs]
            titles = [d.title for d in docs]
            data = P.merge(datas, titles=titles)
            extra = f" (+{len(docs) - 1})" if len(docs) > 1 else ""
            title = f"Merged — {docs[0].title}{extra}"
            folder = docs[0].folder
        elif job.type == "alternate_mix":
            a = _source_document(job, job.params["document_a"])
            b = _source_document(job, job.params["document_b"])
            data = P.alternate_mix(_version_bytes(a.current_version),
                                   _version_bytes(b.current_version),
                                   reverse_b=job.params.get("reverse_b", False))
            title = f"Mixed — {a.title} + {b.title}"
            folder = a.folder
        elif job.type == "convert_from":
            # Anything → PDF → a *new* document. No primary document in the
            # URL, which is what makes this a cross-document op: the input is
            # an uploaded file or a web address, not something in the library.
            from apps.core.assets import discard_source, load_source

            url = (job.params.get("url") or "").strip()
            if url:
                data, title = CV.convert_from(url=url)
            else:
                refs = job.params.get("upload_refs") or []
                single = job.params.get("upload_ref")
                if single:
                    refs = [single]
                if not refs:
                    job.mark_failed("validation_error",
                                    "Provide a file to convert or a web address.")
                    return
                principal = principal_of(job)
                sources = [load_source(principal, str(r)) for r in refs]
                try:
                    if len(sources) > 1:
                        # Several images become ONE document, a page each, in
                        # the order they were given — which is what the tool
                        # page promises and what a user dropping a stack of
                        # scans expects.
                        data, title = CV.convert_from(
                            images=[blob for blob, _ in sources],
                            fit=job.params.get("fit", "a4"),
                        )
                    else:
                        blob, filename = sources[0]
                        data, title = CV.convert_from(
                            data=blob,
                            filename=job.params.get("filename") or filename,
                            fit=job.params.get("fit", "a4"),
                        )
                finally:
                    # The parked sources have done their job either way. Left
                    # behind they are charged to the principal's storage for
                    # ever with no UI to free them — and for an account,
                    # nothing else ever sweeps that prefix.
                    for ref in refs:
                        discard_source(principal, str(ref))
            folder = None
        else:
            job.mark_failed("validation_error", f"Unsupported cross-doc op '{job.type}'.")
            return

        if _canceled(job):
            return

        new_doc = _create_document_from_bytes(
            principal=principal_of(job), folder=folder, title=title, data=data,
            created_by=created_by_user(job), job=job,
        )
        job.mark_succeeded({"documents": [str(new_doc.id)]})
    except EngineError as exc:
        job.mark_failed(exc.code, exc.message)
    except Document.DoesNotExist:
        job.mark_failed("not_found", "A referenced document was not found.")
    except Exception as exc:  # noqa: BLE001
        job.mark_failed("engine_error", f"Operation failed: {exc}")


@shared_task(name="apps.documents.tasks.revert_version", bind=True)
def revert_version(self, job_id: str):
    """Undo = copy version v{seq} blob as a new head version (§14)."""
    job = Job.objects.select_related("document").get(id=job_id)
    if job.is_terminal:  # redelivery of an already-finished job (§12)
        return
    job.celery_task_id = self.request.id or ""
    job.save(update_fields=["celery_task_id"])
    job.mark_running()
    document = job.document
    target_seq = job.params["seq"]
    try:
        with doc_lock(str(document.id)):
            document.refresh_from_db()
            current = document.current_version
            if job.base_version_seq is not None and (
                current is None or job.base_version_seq != current.seq
            ):
                job.mark_failed("version_conflict",
                                "The document changed since you loaded it.")
                return
            target = document.versions.get(seq=target_seq)
            data = _version_bytes(target)
            if _canceled(job):
                return
            version = _save_new_version(
                document=document, data=data,
                label=f"Reverted to v{target_seq}", created_by=created_by_user(job), job=job,
            )
            job.mark_succeeded({
                "document_id": str(document.id),
                "version_id": str(version.id),
                "seq": version.seq,
            })
    except DocumentVersion.DoesNotExist:
        job.mark_failed("not_found", f"Version {target_seq} not found.")
    except Exception as exc:  # noqa: BLE001
        job.mark_failed("engine_error", f"Revert failed: {exc}")


@shared_task(name="apps.documents.tasks.generate_thumbnails_task", bind=True)
def generate_thumbnails_task(self, document_id: str, seq: int, pages: int, width: int = THUMB_WIDTH):
    """Render + cache the first `pages` thumbnails (render queue). Best-effort."""
    try:
        document = Document.objects.get(id=document_id)
        version = document.versions.get(seq=seq)
    except (Document.DoesNotExist, DocumentVersion.DoesNotExist):
        return
    storage = get_storage()
    data = _version_bytes(version)
    for page in range(pages):
        key = f"thumbs/{document_id}/{seq}/p{page}@{width}.png"
        if storage.exists(key):
            continue
        try:
            png = R.render_thumbnail(data, page, width)
            storage.put_bytes(key, png, content_type="image/png")
        except Exception:  # noqa: BLE001
            continue
