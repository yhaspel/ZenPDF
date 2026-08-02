"""Documents API (01-architecture.md §6, §11, §13, §14; phase-01, phase-02)."""
from __future__ import annotations

from django.conf import settings
from django.http import HttpResponse, HttpResponseNotModified, StreamingHttpResponse
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import generics, status
from rest_framework.exceptions import NotFound
from rest_framework.negotiation import DefaultContentNegotiation
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core import captcha
from apps.core import limits as L
from apps.core.authentication import require_principal
from apps.core.exceptions import (
    DocumentEncrypted,
    FileTooLarge,
    QuotaExceeded,
    ValidationFailed,
)
from apps.core.logging import celery_headers
from apps.core.permissions import IsAccount
from apps.core.principals import (
    assert_owned,
    is_guest,
    job_owner_kwargs,
    owned_by,
)
from apps.jobs.models import Job
from apps.jobs.serializers import JobSerializer
from apps.pdf_engine import registry
from apps.pdf_engine.engine import annotations as engine_annotations
from apps.pdf_engine.engine import content as engine_content
from apps.pdf_engine.engine import forms as engine_forms
from apps.pdf_engine.engine import render as engine_render
from apps.pdf_engine.engine import search_text
from apps.pdf_engine.engine import text as engine_text
from apps.pdf_engine.engine.inspect import inspect as inspect_pdf
from apps.pdf_engine.exceptions import DocumentEncryptedError, EngineError
from apps.pdf_engine.storage import get_storage

from .filters import DocumentFilter
from .models import Document, DocumentVersion, Folder
from .serializers import (
    DocumentSerializer,
    DocumentVersionSerializer,
    FolderSerializer,
    OperationRequestSerializer,
)
from .services import ingest_pdf


# --------------------------------------------------------------------------- #
# Shared helpers
# --------------------------------------------------------------------------- #
def _principal(request, *, write: bool = False):
    """This request's principal. `write=True` lazily mints a guest session —
    reads never do, so a bounced visitor costs zero rows (§21.2)."""
    return require_principal(request, mint=write)


def _owned_document(request, pk, *, write: bool = False) -> Document:
    """Fetch a document scoped to the caller's principal.

    404 for everyone else — `assert_owned` never answers 403, which would
    confirm the id exists (§21.2).
    """
    document = generics.get_object_or_404(Document.objects.all(), pk=pk)
    return assert_owned(document, _principal(request, write=write))


def _select_version(document: Document, request) -> DocumentVersion:
    seq = request.query_params.get("version")
    if seq:
        return generics.get_object_or_404(document.versions, seq=seq)
    if document.current_version is None:
        raise ValidationFailed("Document has no content yet.")
    return document.current_version


def _check_concurrency(principal) -> None:
    """Tier-resolved concurrency (1 guest / 3 free / 6 pro, §16).

    Was a single global `settings.MAX_CONCURRENT_JOBS` before 2B.
    """
    limit = L.for_principal(principal).max_concurrent_jobs
    active = owned_by(
        Job.objects.filter(status__in=[Job.Status.QUEUED, Job.Status.RUNNING]), principal
    ).count()
    if active >= limit:
        exc = QuotaExceeded(
            f"You already have {active} job(s) running. Wait for one to finish."
            + (" A free account raises this limit." if is_guest(principal) else "")
        )
        exc.zen_details = {"limit": limit, "tier": L.for_principal(principal).tier}
        raise exc


def _guard_operation(request, op_type: str, principal):
    """Shared pre-flight for both operation entrypoints: challenge (metered ops
    only), then tier-resolved concurrency."""
    captcha.enforce(request, principal, op_type)
    _check_concurrency(principal)


def _parse_range(header: str, size: int):
    if not header or not header.startswith("bytes="):
        return None
    spec = header[len("bytes="):].split(",")[0].strip()
    if "-" not in spec:
        return "invalid"
    a, b = spec.split("-", 1)
    try:
        if a == "":
            n = int(b)
            start, end = max(0, size - n), size - 1
        else:
            start = int(a)
            end = int(b) if b else size - 1
    except ValueError:
        return "invalid"
    if start > end or start >= size or start < 0:
        return "invalid"
    return start, min(end, size - 1)


def _stream_version(version: DocumentVersion, request, *, filename: str,
                    as_attachment: bool = False):
    storage = get_storage()
    size = version.size_bytes
    etag = f'"{version.sha256}"'
    if request.headers.get("If-None-Match") == etag:
        return HttpResponseNotModified()

    disposition = "attachment" if as_attachment else "inline"
    rng = None if as_attachment else _parse_range(request.headers.get("Range", ""), size)

    if rng == "invalid":
        resp = HttpResponse(status=416)
        resp["Content-Range"] = f"bytes */{size}"
        return resp

    if rng:
        start, end = rng
        length = end - start + 1
        resp = StreamingHttpResponse(
            storage.iter_range(version.storage_key, start, end),
            status=206,
            content_type="application/pdf",
        )
        resp["Content-Range"] = f"bytes {start}-{end}/{size}"
        resp["Content-Length"] = str(length)
    else:
        resp = StreamingHttpResponse(
            storage.iter_range(version.storage_key, 0, size - 1) if size else iter([b""]),
            status=200,
            content_type="application/pdf",
        )
        resp["Content-Length"] = str(size)

    resp["Accept-Ranges"] = "bytes"
    resp["ETag"] = etag
    resp["Cache-Control"] = "private, max-age=0, must-revalidate"
    resp["Content-Disposition"] = f'{disposition}; filename="{filename}"'
    return resp


# --------------------------------------------------------------------------- #
# Ingest + list
# --------------------------------------------------------------------------- #
class DocumentListCreateView(generics.ListCreateAPIView):
    serializer_class = DocumentSerializer
    filterset_class = DocumentFilter
    ordering_fields = ["updated_at", "title", "size_bytes", "created_at"]
    ordering = ["-updated_at"]

    def get_throttles(self):
        """The per-account upload rate **in addition to** the defaults (§9B).

        Replacing `throttle_classes` would drop the guest throttles on a
        guest-reachable write, which is the mistake `core/views.py` documents.
        """
        from apps.core.throttling import UploadThrottle

        return [*super().get_throttles(), UploadThrottle()]

    def get_queryset(self):
        qs = owned_by(
            Document.objects.select_related("current_version"), _principal(self.request)
        )
        # Default library hides trashed docs; ?trashed=true surfaces them.
        if "trashed" not in self.request.query_params:
            qs = qs.filter(trashed_at__isnull=True)
        return qs

    @extend_schema(tags=["documents"])
    def get(self, request, *args, **kwargs):
        return super().get(request, *args, **kwargs)

    @extend_schema(tags=["documents"], request=OpenApiTypes.OBJECT, responses=DocumentSerializer)
    def post(self, request, *args, **kwargs):
        upload = request.FILES.get("file")
        if upload is None:
            raise ValidationFailed("No file was uploaded (field 'file').")

        # Upload is a write, so this is where a guest session is minted (§21.2).
        principal = _principal(request, write=True)
        if principal is None:
            raise ValidationFailed("Guest access is disabled; sign in to upload.")
        tier = L.for_principal(principal)

        if upload.size > tier.max_upload_bytes:
            exc = FileTooLarge(
                f"Maximum upload size is {tier.max_upload_bytes // (1024 * 1024)} MB."
                + (" Create a free account to upload larger files."
                   if is_guest(principal) else "")
            )
            exc.zen_details = {
                "max_upload_bytes": tier.max_upload_bytes, "tier": tier.tier,
            }
            raise exc

        used = L.storage_used(principal)
        if used + upload.size > tier.storage_bytes:
            exc = QuotaExceeded(
                "Uploading this file would exceed your storage quota."
                + (" Create a free account for 2 GB of storage."
                   if is_guest(principal) else "")
            )
            exc.zen_details = {
                "quota_bytes": tier.storage_bytes, "used_bytes": used, "tier": tier.tier,
            }
            raise exc

        data = upload.read()
        want_repair = request.query_params.get("repair") == "true"

        title = (request.data.get("title") or upload.name or "Untitled").rsplit(".pdf", 1)[0]
        folder = None
        folder_id = request.data.get("folder")
        if folder_id:
            # Folders are account-only, so a guest simply has none to file into.
            folder = generics.get_object_or_404(
                owned_by(Folder.objects.all(), principal), pk=folder_id
            )

        document = ingest_pdf(principal, data, title, folder=folder, want_repair=want_repair)
        return Response(DocumentSerializer(document).data, status=status.HTTP_201_CREATED)


class DocumentDetailView(generics.RetrieveUpdateDestroyAPIView):
    serializer_class = DocumentSerializer
    http_method_names = ["get", "patch", "delete", "head", "options"]

    def get_queryset(self):
        return owned_by(
            Document.objects.select_related("current_version"), _principal(self.request)
        )

    def perform_update(self, serializer):
        # Only title, folder, starred are user-editable here.
        allowed = {k: v for k, v in serializer.validated_data.items()
                   if k in {"title", "folder", "starred"}}
        serializer.save(**allowed)

    def destroy(self, request, *args, **kwargs):
        document = self.get_object()
        permanent = request.query_params.get("permanent") == "true"
        if permanent:
            if document.trashed_at is None:
                raise ValidationFailed("Move the document to trash before deleting permanently.")
            self._purge(document)
            return Response(status=status.HTTP_204_NO_CONTENT)
        document.trashed_at = timezone.now()
        document.save(update_fields=["trashed_at", "updated_at"])
        return Response(status=status.HTTP_204_NO_CONTENT)

    @staticmethod
    def _purge(document: Document) -> None:
        # Refused *before* a single blob is touched. A signature request holds
        # its frozen `source_version` with `on_delete=PROTECT` (§9), so the
        # delete would fail — but only after the storage was emptied and the
        # quota credited, leaving the rows pointing at files that no longer
        # exist and an in-flight ceremony that can never be completed
        # (phase-08).
        if document.sign_requests.exists():
            raise ValidationFailed(
                "This document has been sent for signature, so it cannot be "
                "deleted — the signed record has to keep pointing at what was "
                "signed. Cancel the request first if it is still open."
            )
        storage = get_storage()
        freed = 0
        for version in document.versions.all():
            freed += version.size_bytes
            try:
                storage.delete(version.storage_key)
            except Exception:  # noqa: BLE001
                pass
        # Credit the quota back to whichever principal owns it — the pre-2B
        # code always wrote the `users` table.
        L.bump_storage(document.principal, -freed)
        # Clear the self-referential current_version before deleting versions.
        document.current_version = None
        document.save(update_fields=["current_version"])
        document.delete()


class DocumentRestoreView(APIView):
    @extend_schema(request=None, responses=DocumentSerializer, tags=["documents"])
    def post(self, request, pk):
        document = _owned_document(request, pk)
        document.trashed_at = None
        document.save(update_fields=["trashed_at", "updated_at"])
        return Response(DocumentSerializer(document).data)


# --------------------------------------------------------------------------- #
# Content delivery
# --------------------------------------------------------------------------- #
class DocumentContentView(APIView):
    @extend_schema(tags=["documents"], responses=OpenApiTypes.BINARY)
    def get(self, request, pk):
        document = _owned_document(request, pk)
        version = _select_version(document, request)
        if settings.PRESIGNED_DELIVERY:
            try:
                url = get_storage().presigned_get(version.storage_key)
                from django.http import HttpResponseRedirect

                return HttpResponseRedirect(url)
            except NotImplementedError:
                pass
        Document.objects.filter(pk=document.pk).update(last_opened_at=timezone.now())
        return _stream_version(version, request, filename=f"{document.title}.pdf")


class DocumentDownloadView(APIView):
    @extend_schema(tags=["documents"], responses=OpenApiTypes.BINARY)
    def get(self, request, pk):
        document = _owned_document(request, pk)
        version = _select_version(document, request)
        return _stream_version(version, request, filename=f"{document.title}.pdf",
                               as_attachment=True)


class ThumbnailView(APIView):
    @extend_schema(tags=["documents"], responses=OpenApiTypes.BINARY)
    def get(self, request, pk, n):
        document = _owned_document(request, pk)
        version = _select_version(document, request)
        try:
            # 2000 rather than 1200 since phase 3: the overlay renders the page
            # it draws on at 2x for HiDPI, and a blurry page makes precise
            # placement guesswork. Still inside the <1 s single-page budget (§3).
            width = max(60, min(int(request.query_params.get("w", 240)), 2000))
        except ValueError:
            width = 240
        if n < 0 or n >= version.page_count:
            return Response(
                {"error": {"code": "not_found", "message": "Page not found.", "details": {}}},
                status=status.HTTP_404_NOT_FOUND,
            )
        # `?annots=false` renders the page without its annotations, for the
        # phase-3 overlay: it draws every annotation itself as editable SVG, so
        # a raster that already contained them would show each one twice — and
        # the baked copy would not move when the editable one is dragged. The
        # flag is part of the cache key, or the two variants would collide.
        with_annots = request.query_params.get("annots", "true") != "false"
        suffix = "" if with_annots else "-clean"
        key = f"thumbs/{document.id}/{version.seq}/p{n}@{width}{suffix}.png"
        storage = get_storage()
        if storage.exists(key):
            png = storage.get_bytes(key)
        else:
            try:
                blob = storage.get_bytes(version.storage_key)
                png = engine_render.render_thumbnail(blob, n, width, annots=with_annots)
                storage.put_bytes(key, png, content_type="image/png")
            except DocumentEncryptedError as exc:
                # 423, not 400: "unlock it" is a thing the client can do, and
                # the thumbnail strip of a protected document asks for one of
                # these per page (phase-07).
                raise DocumentEncrypted(exc.message) from exc
            except EngineError as exc:
                raise ValidationFailed(exc.message) from exc
        resp = HttpResponse(png, content_type="image/png")
        resp["Cache-Control"] = "private, max-age=86400"
        return resp


# --------------------------------------------------------------------------- #
# Versions / outline / search
# --------------------------------------------------------------------------- #
class VersionListView(generics.ListAPIView):
    serializer_class = DocumentVersionSerializer
    pagination_class = None

    def get_queryset(self):
        # Schema generation introspects the queryset with no URL kwargs bound.
        if getattr(self, "swagger_fake_view", False):
            return DocumentVersion.objects.none()
        document = _owned_document(self.request, self.kwargs["pk"])
        return document.versions.select_related("job", "created_by").all()


class RevertVersionView(APIView):
    @extend_schema(request=None, responses=JobSerializer, tags=["documents"])
    def post(self, request, pk, seq):
        document = _owned_document(request, pk)
        generics.get_object_or_404(document.versions, seq=seq)
        principal = _principal(request)
        _guard_operation(request, "revert_version", principal)
        current = document.current_version
        job = Job.objects.create(
            **job_owner_kwargs(principal), document=document, type="revert_version",
            params={"seq": int(seq)},
            base_version_seq=current.seq if current else None,
        )
        from .tasks import revert_version

        result = revert_version.apply_async(args=[str(job.id)], queue="default",
                                            headers=celery_headers())
        job.celery_task_id = getattr(result, "id", "") or ""
        job.save(update_fields=["celery_task_id"])
        return Response(JobSerializer(job).data, status=status.HTTP_202_ACCEPTED)


class OutlineView(APIView):
    @extend_schema(tags=["documents"], responses=OpenApiTypes.OBJECT)
    def get(self, request, pk):
        document = _owned_document(request, pk)
        version = _select_version(document, request)
        try:
            blob = get_storage().get_bytes(version.storage_key)
            info = inspect_pdf(blob)
        except EngineError as exc:
            raise ValidationFailed(exc.message) from exc
        return Response({"outline": info["toc"]})


def _page_read_model(request, pk, fn):
    """Shared shape for the per-page read models: own the document, pick the
    version, run one pure engine function."""
    document = _owned_document(request, pk)
    version = _select_version(document, request)
    try:
        page = int(request.query_params.get("page", 0))
    except ValueError:
        page = 0
    try:
        blob = get_storage().get_bytes(version.storage_key)
        return fn(blob, page)
    except EngineError as exc:
        raise ValidationFailed(exc.message) from exc


class AnnotationListView(APIView):
    """`GET /api/documents/{id}/annotations/?version=` (phase-03).

    Annotations are read straight out of the PDF — there is no sidecar table, so
    this is the *only* source of truth and it cannot drift from the file the user
    downloads.
    """

    @extend_schema(tags=["annotations"], responses=OpenApiTypes.OBJECT)
    def get(self, request, pk):
        document = _owned_document(request, pk)
        version = _select_version(document, request)
        pages = None
        page_param = request.query_params.get("page")
        if page_param is not None:
            try:
                pages = [int(page_param)]
            except ValueError:
                pages = None
        try:
            blob = get_storage().get_bytes(version.storage_key)
            items = engine_annotations.extract_annotations(blob, pages=pages)
        except EngineError as exc:
            raise ValidationFailed(exc.message) from exc
        return Response({"version": version.seq, "annotations": items})


class TextWordsView(APIView):
    """`GET /api/documents/{id}/text-words/?page=` (phase-03).

    The overlay's text layer. Text-markup tools (highlight/underline/strikeout/
    squiggly) need the quads of a selection, and taking them from the same
    PyMuPDF that will *apply* the annotation removes an entire class of
    coordinate drift — including on RTL text, where each word carries its own
    rect and visual order is what the reader sees.
    """

    @extend_schema(tags=["annotations"], responses=OpenApiTypes.OBJECT)
    def get(self, request, pk):
        document = _owned_document(request, pk)
        version = _select_version(document, request)
        try:
            page = int(request.query_params.get("page", 0))
        except ValueError:
            page = 0
        try:
            blob = get_storage().get_bytes(version.storage_key)
            words = engine_text.page_words(blob, page)
        except EngineError as exc:
            raise ValidationFailed(exc.message) from exc
        return Response({"page": page, **words})


class TextBlocksView(APIView):
    """`GET /api/documents/{id}/text-blocks/?page=` (phase-04 "Read model").

    The editable unit is a *block*: PyMuPDF's own grouping, distilled to the
    text, its box and the dominant span style. `is_scanned_page` is what the
    editor gates on — a page of pixels has nothing to click.
    """

    @extend_schema(tags=["content"], responses=OpenApiTypes.OBJECT)
    def get(self, request, pk):
        return Response(_page_read_model(request, pk, engine_content.text_blocks))


class PageImagesView(APIView):
    """`GET /api/documents/{id}/images/?page=` — xref, size and box per image."""

    @extend_schema(tags=["content"], responses=OpenApiTypes.OBJECT)
    def get(self, request, pk):
        return Response(_page_read_model(request, pk, engine_content.page_images))


class PageLinksView(APIView):
    """`GET /api/documents/{id}/links/?page=` — existing link annotations."""

    @extend_schema(tags=["content"], responses=OpenApiTypes.OBJECT)
    def get(self, request, pk):
        return Response(_page_read_model(request, pk, engine_content.page_links))


class FormView(APIView):
    """`GET /api/documents/{id}/form/` (phase-05 §"Read model").

    Reports `is_xfa` alongside the fields: an XFA document's AcroForm layer is a
    partial fallback, so filling it in may not carry the user's answers. The UI
    warns rather than letting them find out later.
    """

    @extend_schema(tags=["forms"], responses=OpenApiTypes.OBJECT)
    def get(self, request, pk):
        document = _owned_document(request, pk)
        version = _select_version(document, request)
        try:
            blob = get_storage().get_bytes(version.storage_key)
            return Response(engine_forms.read_form(blob))
        except EngineError as exc:
            raise ValidationFailed(exc.message) from exc


class _OwnFormatParam(DefaultContentNegotiation):
    """`?format=` belongs to the endpoint here, not to DRF.

    DRF reads `?format=` as a renderer override, so `format=csv` 404s during
    content negotiation — before the view ever runs — and `format=json` only
    works by accident. The phase-05 contract spells the parameter `json|csv`,
    so negotiation is pinned to the first renderer and the view reads the
    parameter itself. Errors still come back as JSON.
    """

    def select_renderer(self, request, renderers, format_suffix=None):
        return renderers[0], renderers[0].media_type


class FormExportView(APIView):
    """`GET /api/documents/{id}/form/export/?format=json|csv` — current values."""

    content_negotiation_class = _OwnFormatParam

    @extend_schema(tags=["forms"], responses=OpenApiTypes.BINARY)
    def get(self, request, pk):
        document = _owned_document(request, pk)
        version = _select_version(document, request)
        fmt = request.query_params.get("format", "json")
        try:
            blob = get_storage().get_bytes(version.storage_key)
            payload, filename, content_type = engine_forms.export_form_data(blob, fmt=fmt)
        except EngineError as exc:
            raise ValidationFailed(exc.message) from exc
        response = HttpResponse(payload, content_type=content_type)
        # Always an attachment: this is user content, and §17/phase-10 keep
        # user content out of the inline-render path.
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
        return response


class TextSearchView(APIView):
    @extend_schema(tags=["documents"], responses=OpenApiTypes.OBJECT)
    def get(self, request, pk):
        document = _owned_document(request, pk)
        version = _select_version(document, request)
        q = request.query_params.get("q", "").strip()
        if not q:
            return Response({"query": "", "hits": []})
        pages = None
        page_param = request.query_params.get("page")
        if page_param is not None:
            try:
                pages = [int(page_param)]
            except ValueError:
                pages = None
        try:
            blob = get_storage().get_bytes(version.storage_key)
            hits = search_text(blob, q, pages)
        except EngineError as exc:
            raise ValidationFailed(exc.message) from exc
        return Response({"query": q, "hits": hits})


# --------------------------------------------------------------------------- #
# Operations (job pipeline entrypoints, §11)
# --------------------------------------------------------------------------- #
class DocumentOperationView(APIView):
    """POST /api/documents/{id}/operations/ — single-document ops (§11)."""

    @extend_schema(request=OperationRequestSerializer, responses=JobSerializer, tags=["operations"])
    def post(self, request, pk):
        # No `write=True`: an operation targets a document the caller already
        # owns, so they already have a principal. Minting before the ownership
        # check would create a session row for anyone probing document ids.
        document = _owned_document(request, pk)
        principal = _principal(request)
        serializer = OperationRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        op_type = serializer.validated_data["type"]
        params = serializer.validated_data.get("params", {})
        base_seq = serializer.validated_data.get("base_version_seq")
        document_password = serializer.validated_data.get("document_password", "")

        op = registry.OPERATIONS.get(op_type)
        if op is None or op.is_cross_document:
            raise ValidationFailed(
                f"'{op_type}' is not a valid single-document operation."
            )
        # Phase 1 refused every operation on an encrypted document, which was
        # right when nothing could unlock one. Phase 7 can: the three ops whose
        # subject *is* the lock carry their own credentials, and any other op
        # may carry the session password the UI holds in memory (§17).
        from apps.documents.tasks import SELF_UNLOCKING

        if document.is_encrypted and op_type not in SELF_UNLOCKING \
                and not document_password:
            raise DocumentEncrypted()
        try:
            registry.validate_params(op_type, params)
        except EngineError as exc:
            raise ValidationFailed(exc.message) from exc
        _guard_operation(request, op_type, principal)
        if document_password or any(key in params for key in Job.SENSITIVE_PARAMS):
            # Five wrong passwords a minute for this document and the next
            # attempt is refused, whoever is asking — the thing being guessed
            # at belongs to the document, not to the session (phase-07).
            L.enforce_password_attempts(document.id)
        if op_type == "ocr":
            # Before the hourly window is charged: OCR is the most expensive
            # thing we do, and a document past the monthly page quota should be
            # refused rather than started and abandoned (§16, phase-06 risks).
            L.enforce_ocr_pages(principal, document.page_count)
        L.enforce_metered_op(principal, op_type)

        if document_password:
            # Carried on the job so the worker can unlock, redacted from every
            # response and dropped from the row when the job finishes
            # (`Job.SENSITIVE_PARAMS`). Validated *after* the op schema, so no
            # schema has to allow it.
            params = {**params, "document_password": document_password}

        job = Job.objects.create(
            **job_owner_kwargs(principal), document=document, type=op_type,
            params=params, base_version_seq=base_seq,
        )
        from .tasks import run_operation

        result = run_operation.apply_async(args=[str(job.id)], queue=op.queue,
                                           headers=celery_headers())
        job.celery_task_id = getattr(result, "id", "") or ""
        job.save(update_fields=["celery_task_id"])
        return Response(JobSerializer(job).data, status=status.HTTP_202_ACCEPTED)


class CrossDocumentOperationView(APIView):
    """POST /api/operations/ — cross-document ops: merge, alternate_mix (§11)."""

    @extend_schema(request=OperationRequestSerializer, responses=JobSerializer, tags=["operations"])
    def post(self, request):
        serializer = OperationRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        op_type = serializer.validated_data["type"]
        params = serializer.validated_data.get("params", {})

        op = registry.OPERATIONS.get(op_type)
        if op is None or not op.is_cross_document:
            raise ValidationFailed(f"'{op_type}' is not a valid cross-document operation.")
        try:
            registry.validate_params(op_type, params)
        except EngineError as exc:
            raise ValidationFailed(exc.message) from exc

        if op_type == "convert_from":
            # Layer 1 of the SSRF guard, at the edge (§17, phase-06): checked
            # here so the user gets an immediate 400 rather than a job that
            # fails a minute later, and again in the worker because params are
            # stored and could be replayed.
            url = (params.get("url") or "").strip()
            if url:
                from apps.core.urlguard import check_url

                try:
                    check_url(url)
                except EngineError as exc:
                    raise ValidationFailed(exc.message) from exc
            elif not (params.get("upload_ref") or params.get("upload_refs")):
                raise ValidationFailed("Provide a file to convert or a web address.")

        # Ownership + encryption check on every source document. Minting only
        # where there are none to own: `convert_from` starts from an uploaded
        # file or a URL, so a guest converting one may have no session yet.
        principal = _principal(request, write=not op.source_id_params)
        if principal is None:
            raise NotFound("Not found.")
        ids = []
        for key in op.source_id_params:
            val = params.get(key)
            ids.extend(val if isinstance(val, list) else [val])
        for doc_id in ids:
            doc = _owned_document(request, doc_id)
            if doc.is_encrypted:
                raise DocumentEncrypted()
        _guard_operation(request, op_type, principal)
        L.enforce_metered_op(principal, op_type)

        job = Job.objects.create(**job_owner_kwargs(principal), type=op_type, params=params)
        from .tasks import run_cross_document_operation

        result = run_cross_document_operation.apply_async(
            args=[str(job.id)], queue=op.queue, headers=celery_headers())
        job.celery_task_id = getattr(result, "id", "") or ""
        job.save(update_fields=["celery_task_id"])
        return Response(JobSerializer(job).data, status=status.HTTP_202_ACCEPTED)


# --------------------------------------------------------------------------- #
# Folders — account-only (§21.3): guests get a flat session workspace, and a
# library needs a durable identity to exist at all.
# --------------------------------------------------------------------------- #
class FolderListCreateView(generics.ListCreateAPIView):
    serializer_class = FolderSerializer
    permission_classes = [IsAccount]
    pagination_class = None
    account_required_message = "Create a free account to organize files into folders."

    def get_queryset(self):
        return owned_by(Folder.objects.all(), _principal(self.request))

    def perform_create(self, serializer):
        serializer.save(**{"owner": _principal(self.request)})


class FolderDetailView(generics.RetrieveUpdateDestroyAPIView):
    serializer_class = FolderSerializer
    permission_classes = [IsAccount]
    account_required_message = "Create a free account to organize files into folders."

    def get_queryset(self):
        return owned_by(Folder.objects.all(), _principal(self.request))

    def destroy(self, request, *args, **kwargs):
        folder = self.get_object()
        cascade = request.query_params.get("cascade") == "trash"
        has_docs = folder.documents.exists()
        has_children = folder.children.exists()
        if (has_docs or has_children) and not cascade:
            raise ValidationFailed(
                "Folder is not empty. Move its contents or pass ?cascade=trash."
            )
        if cascade:
            # Trash documents in this folder and its descendants, then delete the tree.
            # `seen` keeps a cyclic folder graph from looping forever.
            stack = [folder]
            seen = set()
            all_folders = []
            while stack:
                f = stack.pop()
                if f.pk in seen:
                    continue
                seen.add(f.pk)
                all_folders.append(f)
                stack.extend(list(f.children.all()))
            owned_by(
                Document.objects.filter(folder__in=all_folders), _principal(request)
            ).update(trashed_at=timezone.now())
        folder.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
