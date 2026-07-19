"""Documents API (01-architecture.md §6, §11, §13, §14; phase-01, phase-02)."""
from __future__ import annotations

from django.conf import settings
from django.http import HttpResponse, HttpResponseNotModified, StreamingHttpResponse
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import generics, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.exceptions import (
    DocumentEncrypted,
    FileTooLarge,
    QuotaExceeded,
    ValidationFailed,
)
from apps.jobs.models import Job
from apps.jobs.serializers import JobSerializer
from apps.pdf_engine import registry
from apps.pdf_engine.engine import render as engine_render
from apps.pdf_engine.engine import search_text
from apps.pdf_engine.engine.inspect import inspect as inspect_pdf
from apps.pdf_engine.exceptions import EngineError
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
def _owned_document(user, pk) -> Document:
    return generics.get_object_or_404(Document.objects.filter(owner=user), pk=pk)


def _select_version(document: Document, request) -> DocumentVersion:
    seq = request.query_params.get("version")
    if seq:
        return generics.get_object_or_404(document.versions, seq=seq)
    if document.current_version is None:
        raise ValidationFailed("Document has no content yet.")
    return document.current_version


def _check_concurrency(user) -> None:
    active = Job.objects.filter(
        user=user, status__in=[Job.Status.QUEUED, Job.Status.RUNNING]
    ).count()
    if active >= settings.MAX_CONCURRENT_JOBS:
        exc = QuotaExceeded(
            f"You already have {active} jobs running. Wait for one to finish."
        )
        exc.zen_details = {"limit": settings.MAX_CONCURRENT_JOBS}
        raise exc


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
    permission_classes = [IsAuthenticated]
    filterset_class = DocumentFilter
    ordering_fields = ["updated_at", "title", "size_bytes", "created_at"]
    ordering = ["-updated_at"]

    def get_queryset(self):
        qs = Document.objects.filter(owner=self.request.user).select_related("current_version")
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

        max_bytes = settings.MAX_UPLOAD_MB * 1024 * 1024
        if upload.size > max_bytes:
            raise FileTooLarge(f"Maximum upload size is {settings.MAX_UPLOAD_MB} MB.")

        user = request.user
        quota_bytes = settings.USER_STORAGE_QUOTA_MB * 1024 * 1024
        if user.storage_bytes_used + upload.size > quota_bytes:
            exc = QuotaExceeded("Uploading this file would exceed your storage quota.")
            exc.zen_details = {"quota_bytes": quota_bytes, "used_bytes": user.storage_bytes_used}
            raise exc

        data = upload.read()
        want_repair = request.query_params.get("repair") == "true"

        title = (request.data.get("title") or upload.name or "Untitled").rsplit(".pdf", 1)[0]
        folder = None
        folder_id = request.data.get("folder")
        if folder_id:
            folder = generics.get_object_or_404(Folder.objects.filter(owner=user), pk=folder_id)

        document = ingest_pdf(user, data, title, folder=folder, want_repair=want_repair)
        return Response(DocumentSerializer(document).data, status=status.HTTP_201_CREATED)


class DocumentDetailView(generics.RetrieveUpdateDestroyAPIView):
    serializer_class = DocumentSerializer
    permission_classes = [IsAuthenticated]
    http_method_names = ["get", "patch", "delete", "head", "options"]

    def get_queryset(self):
        return Document.objects.filter(owner=self.request.user).select_related("current_version")

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
        storage = get_storage()
        freed = 0
        for version in document.versions.all():
            freed += version.size_bytes
            try:
                storage.delete(version.storage_key)
            except Exception:  # noqa: BLE001
                pass
        from django.db.models import F

        owner = document.owner
        type(owner).objects.filter(pk=owner.pk).update(
            storage_bytes_used=F("storage_bytes_used") - freed
        )
        # Clear the self-referential current_version before deleting versions.
        document.current_version = None
        document.save(update_fields=["current_version"])
        document.delete()


class DocumentRestoreView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses=DocumentSerializer, tags=["documents"])
    def post(self, request, pk):
        document = _owned_document(request.user, pk)
        document.trashed_at = None
        document.save(update_fields=["trashed_at", "updated_at"])
        return Response(DocumentSerializer(document).data)


# --------------------------------------------------------------------------- #
# Content delivery
# --------------------------------------------------------------------------- #
class DocumentContentView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(tags=["documents"], responses=OpenApiTypes.BINARY)
    def get(self, request, pk):
        document = _owned_document(request.user, pk)
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
    permission_classes = [IsAuthenticated]

    @extend_schema(tags=["documents"], responses=OpenApiTypes.BINARY)
    def get(self, request, pk):
        document = _owned_document(request.user, pk)
        version = _select_version(document, request)
        return _stream_version(version, request, filename=f"{document.title}.pdf",
                               as_attachment=True)


class ThumbnailView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(tags=["documents"], responses=OpenApiTypes.BINARY)
    def get(self, request, pk, n):
        document = _owned_document(request.user, pk)
        version = _select_version(document, request)
        try:
            width = max(60, min(int(request.query_params.get("w", 240)), 1200))
        except ValueError:
            width = 240
        if n < 0 or n >= version.page_count:
            return Response(
                {"error": {"code": "not_found", "message": "Page not found.", "details": {}}},
                status=status.HTTP_404_NOT_FOUND,
            )
        key = f"thumbs/{document.id}/{version.seq}/p{n}@{width}.png"
        storage = get_storage()
        if storage.exists(key):
            png = storage.get_bytes(key)
        else:
            try:
                blob = storage.get_bytes(version.storage_key)
                png = engine_render.render_thumbnail(blob, n, width)
                storage.put_bytes(key, png, content_type="image/png")
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
    permission_classes = [IsAuthenticated]
    pagination_class = None

    def get_queryset(self):
        document = _owned_document(self.request.user, self.kwargs["pk"])
        return document.versions.select_related("job", "created_by").all()


class RevertVersionView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses=JobSerializer, tags=["documents"])
    def post(self, request, pk, seq):
        document = _owned_document(request.user, pk)
        generics.get_object_or_404(document.versions, seq=seq)
        _check_concurrency(request.user)
        job = Job.objects.create(
            user=request.user, document=document, type="revert_version",
            params={"seq": int(seq)}, base_version_seq=None,
        )
        from .tasks import revert_version

        result = revert_version.apply_async(args=[str(job.id)], queue="default")
        job.celery_task_id = getattr(result, "id", "") or ""
        job.save(update_fields=["celery_task_id"])
        return Response(JobSerializer(job).data, status=status.HTTP_202_ACCEPTED)


class OutlineView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(tags=["documents"], responses=OpenApiTypes.OBJECT)
    def get(self, request, pk):
        document = _owned_document(request.user, pk)
        version = _select_version(document, request)
        try:
            blob = get_storage().get_bytes(version.storage_key)
            info = inspect_pdf(blob)
        except EngineError as exc:
            raise ValidationFailed(exc.message) from exc
        return Response({"outline": info["toc"]})


class TextSearchView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(tags=["documents"], responses=OpenApiTypes.OBJECT)
    def get(self, request, pk):
        document = _owned_document(request.user, pk)
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

    permission_classes = [IsAuthenticated]

    @extend_schema(request=OperationRequestSerializer, responses=JobSerializer, tags=["operations"])
    def post(self, request, pk):
        document = _owned_document(request.user, pk)
        serializer = OperationRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        op_type = serializer.validated_data["type"]
        params = serializer.validated_data.get("params", {})
        base_seq = serializer.validated_data.get("base_version_seq")

        op = registry.OPERATIONS.get(op_type)
        if op is None or op.is_cross_document:
            raise ValidationFailed(
                f"'{op_type}' is not a valid single-document operation."
            )
        if document.is_encrypted:
            raise DocumentEncrypted()
        try:
            registry.validate_params(op_type, params)
        except EngineError as exc:
            raise ValidationFailed(exc.message) from exc
        _check_concurrency(request.user)

        job = Job.objects.create(
            user=request.user, document=document, type=op_type,
            params=params, base_version_seq=base_seq,
        )
        from .tasks import run_operation

        result = run_operation.apply_async(args=[str(job.id)], queue=op.queue)
        job.celery_task_id = getattr(result, "id", "") or ""
        job.save(update_fields=["celery_task_id"])
        return Response(JobSerializer(job).data, status=status.HTTP_202_ACCEPTED)


class CrossDocumentOperationView(APIView):
    """POST /api/operations/ — cross-document ops: merge, alternate_mix (§11)."""

    permission_classes = [IsAuthenticated]

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

        # Ownership + encryption check on every source document.
        ids = []
        for key in op.source_id_params:
            val = params.get(key)
            ids.extend(val if isinstance(val, list) else [val])
        for doc_id in ids:
            doc = _owned_document(request.user, doc_id)
            if doc.is_encrypted:
                raise DocumentEncrypted()
        _check_concurrency(request.user)

        job = Job.objects.create(user=request.user, type=op_type, params=params)
        from .tasks import run_cross_document_operation

        result = run_cross_document_operation.apply_async(args=[str(job.id)], queue=op.queue)
        job.celery_task_id = getattr(result, "id", "") or ""
        job.save(update_fields=["celery_task_id"])
        return Response(JobSerializer(job).data, status=status.HTTP_202_ACCEPTED)


# --------------------------------------------------------------------------- #
# Folders
# --------------------------------------------------------------------------- #
class FolderListCreateView(generics.ListCreateAPIView):
    serializer_class = FolderSerializer
    permission_classes = [IsAuthenticated]
    pagination_class = None

    def get_queryset(self):
        return Folder.objects.filter(owner=self.request.user)

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)


class FolderDetailView(generics.RetrieveUpdateDestroyAPIView):
    serializer_class = FolderSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return Folder.objects.filter(owner=self.request.user)

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
            stack = [folder]
            all_folders = []
            while stack:
                f = stack.pop()
                all_folders.append(f)
                stack.extend(list(f.children.all()))
            Document.objects.filter(folder__in=all_folders).update(trashed_at=timezone.now())
        folder.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
