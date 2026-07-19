"""Job model + lifecycle (01-architecture.md §9, §11)."""
import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone


class Job(models.Model):
    class Status(models.TextChoices):
        QUEUED = "queued"
        RUNNING = "running"
        SUCCEEDED = "succeeded"
        FAILED = "failed"
        CANCELED = "canceled"

    TERMINAL = {Status.SUCCEEDED, Status.FAILED, Status.CANCELED}

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="jobs"
    )
    document = models.ForeignKey(
        "documents.Document", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="jobs",
    )
    type = models.CharField(max_length=64)
    params = models.JSONField(default=dict, blank=True)
    base_version_seq = models.IntegerField(null=True, blank=True)
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.QUEUED)
    progress = models.IntegerField(default=0)
    error_code = models.CharField(max_length=64, blank=True)
    error_message = models.TextField(blank=True)
    result = models.JSONField(null=True, blank=True)
    celery_task_id = models.CharField(max_length=255, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["user", "status"]),
            models.Index(fields=["document"]),
        ]

    def __str__(self) -> str:
        return f"{self.type} [{self.status}] {self.id}"

    # --- lifecycle helpers (used by the worker, §11) ---
    def mark_running(self) -> None:
        self.status = self.Status.RUNNING
        self.started_at = timezone.now()
        self.save(update_fields=["status", "started_at"])

    def set_progress(self, pct: int) -> None:
        self.progress = max(0, min(100, int(pct)))
        self.save(update_fields=["progress"])

    def mark_succeeded(self, result: dict | None = None) -> None:
        self.status = self.Status.SUCCEEDED
        self.progress = 100
        self.result = result or {}
        self.finished_at = timezone.now()
        self.save(update_fields=["status", "progress", "result", "finished_at"])

    def mark_failed(self, code: str, message: str) -> None:
        self.status = self.Status.FAILED
        self.error_code = code
        self.error_message = message
        self.finished_at = timezone.now()
        self.save(update_fields=["status", "error_code", "error_message", "finished_at"])

    def mark_canceled(self) -> None:
        self.status = self.Status.CANCELED
        self.finished_at = timezone.now()
        self.save(update_fields=["status", "finished_at"])

    @property
    def is_terminal(self) -> bool:
        return self.status in self.TERMINAL
