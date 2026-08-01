"""Document domain models (01-architecture.md §9, §13, §14)."""
import uuid

from django.conf import settings
from django.db import models
from django.db.models import Max


class Folder(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="folders"
    )
    parent = models.ForeignKey(
        "self", on_delete=models.CASCADE, null=True, blank=True, related_name="children"
    )
    name = models.CharField(max_length=255)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["owner", "parent", "name"], name="uniq_folder_owner_parent_name"
            ),
        ]
        ordering = ["name"]

    def __str__(self) -> str:
        return self.name


class Document(models.Model):
    class Status(models.TextChoices):
        READY = "ready"
        PROCESSING = "processing"
        ERROR = "error"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # Exactly one of owner/guest_session is set (§21.2) — enforced by the DB
    # CheckConstraint below, not by convention. Never assign either directly;
    # go through apps.core.principals.owner_kwargs().
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, null=True, blank=True,
        related_name="documents",
    )
    guest_session = models.ForeignKey(
        "core.GuestSession", on_delete=models.CASCADE, null=True, blank=True,
        related_name="documents",
    )
    # Set for guest documents; cleared when an account claims them (§21.5).
    expires_at = models.DateTimeField(null=True, blank=True)
    folder = models.ForeignKey(
        Folder, on_delete=models.SET_NULL, null=True, blank=True, related_name="documents"
    )
    title = models.CharField(max_length=255)
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.PROCESSING)
    page_count = models.IntegerField(default=0)
    size_bytes = models.BigIntegerField(default=0)
    is_encrypted = models.BooleanField(default=False)
    starred = models.BooleanField(default=False)
    # Populated at ingest from PyMuPDF metadata (author/subject/keywords/dates);
    # updated by set_metadata (P4). Amendment to §9 — avoids blob reads on the
    # info popover. See PROGRESS.md Decisions log.
    metadata = models.JSONField(default=dict, blank=True)
    current_version = models.ForeignKey(
        "DocumentVersion", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
    )
    error_message = models.TextField(blank=True)
    last_opened_at = models.DateTimeField(null=True, blank=True)
    trashed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]
        indexes = [
            models.Index(fields=["owner", "trashed_at"]),
            models.Index(fields=["owner", "starred"]),
            models.Index(fields=["guest_session", "trashed_at"]),
        ]
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(owner__isnull=False, guest_session__isnull=True)
                    | models.Q(owner__isnull=True, guest_session__isnull=False)
                ),
                name="document_exactly_one_principal",
            ),
        ]

    def __str__(self) -> str:
        return self.title

    @property
    def principal(self):
        """The owning principal — use this, never `.owner` directly (§21.2)."""
        return self.guest_session or self.owner

    def next_version_seq(self) -> int:
        current = self.versions.aggregate(m=Max("seq"))["m"] or 0
        return current + 1

    def record_version(self, *, storage_key, size_bytes, page_count, sha256, label,
                       created_by=None, job=None, seq=None, make_current=True) -> "DocumentVersion":
        """Create an immutable version and (optionally) advance current_version."""
        seq = seq or self.next_version_seq()
        version = DocumentVersion.objects.create(
            document=self,
            seq=seq,
            storage_key=storage_key,
            size_bytes=size_bytes,
            page_count=page_count,
            sha256=sha256,
            label=label,
            created_by=created_by,
            job=job,
        )
        if make_current:
            self.current_version = version
            self.page_count = page_count
            self.size_bytes = size_bytes
            self.status = self.Status.READY
            self.save(update_fields=["current_version", "page_count", "size_bytes",
                                     "status", "updated_at"])
        return version


class DocumentVersion(models.Model):
    """Immutable version blob pointer (§14). Never updated after creation."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="versions")
    seq = models.IntegerField()
    storage_key = models.CharField(max_length=512)
    size_bytes = models.BigIntegerField(default=0)
    page_count = models.IntegerField(default=0)
    sha256 = models.CharField(max_length=64)
    label = models.CharField(max_length=120, default="Version")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
    )
    job = models.ForeignKey(
        "jobs.Job", on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-seq"]
        constraints = [
            models.UniqueConstraint(fields=["document", "seq"], name="uniq_version_doc_seq"),
        ]

    def __str__(self) -> str:
        return f"{self.document_id} v{self.seq} ({self.label})"
