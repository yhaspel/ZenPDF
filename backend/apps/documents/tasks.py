"""Job worker pipeline (01-architecture.md §11, §12, §14).

Every mutation: acquire doc lock → refetch → base_version_seq guard → download →
pure engine fn → measure → upload new version blob → create immutable version →
advance document. On any exception the document is untouched (versions immutable).
"""
from __future__ import annotations

import contextlib
import hashlib

from celery import shared_task
from django.conf import settings

from apps.core import limits as L
from apps.core.principals import is_guest, owned_by, owner_kwargs, principal_of
from apps.jobs.models import Job
from apps.pdf_engine import registry
from apps.pdf_engine.engine import pages as P
from apps.pdf_engine.engine import render as R
from apps.pdf_engine.exceptions import EngineError
from apps.pdf_engine.storage import get_storage

from .models import Document, DocumentVersion

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

    doc = Document.objects.create(
        **owner_kwargs(principal),
        expires_at=guest_expiry() if is_guest(principal) else None,
        folder=folder, title=title[:255], status=Document.Status.PROCESSING,
    )
    sha, pages, size = _measure(data)
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


def _apply_single(op, primary_bytes, params, source_bytes):
    """Return (kind, payload, label, report). kind ∈ {version, documents}."""
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
    op = registry.get_op(job.type)
    try:
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
            source_bytes = []
            for key in op.source_id_params:
                src_id = job.params.get(key)
                if src_id:
                    src_doc = _source_document(job, src_id)
                    source_bytes.append(_version_bytes(src_doc.current_version))

            kind, payload, label, report = _apply_single(op, primary_bytes, job.params, source_bytes)

            # Last point before the result is committed — honour a cancel that
            # arrived while the engine was working.
            if _canceled(job):
                return

            if kind == "version":
                version = _save_new_version(document=document, data=payload, label=label,
                                            created_by=job.user, job=job)
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
                        created_by=job.user, job=job,
                    )
                    created.append(str(new_doc.id))
                job.mark_succeeded({"documents": created})
    except EngineError as exc:
        job.mark_failed(exc.code, exc.message)
    except Document.DoesNotExist:
        job.mark_failed("not_found", "A referenced document was not found.")
    except Exception as exc:  # noqa: BLE001
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
        else:
            job.mark_failed("validation_error", f"Unsupported cross-doc op '{job.type}'.")
            return

        if _canceled(job):
            return

        new_doc = _create_document_from_bytes(
            principal=principal_of(job), folder=folder, title=title, data=data,
            created_by=job.user, job=job,
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
                label=f"Reverted to v{target_seq}", created_by=job.user, job=job,
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
