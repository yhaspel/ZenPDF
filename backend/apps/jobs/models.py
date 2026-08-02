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

    # Params that must never be readable after the job is created (phase-07).
    # Passwords have to travel *somewhere* for the worker to open an encrypted
    # document, and `params` is where every op's inputs live — so they are
    # redacted from every API response and dropped from the row the moment the
    # job finishes. A proper secrets channel is backlog; this is the documented
    # tradeoff, and it is enforced here rather than at each call site.
    SENSITIVE_PARAMS = frozenset({
        "password", "owner_password", "user_password", "document_password",
    })

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # Exactly one of user/guest_session is set (§21.2). The worker must resolve
    # ownership via apps.core.principals.principal_of(job) — reading `job.user`
    # directly yields None for a guest job, and `filter(owner=None)` compiles to
    # `owner_id IS NULL`, i.e. *any* guest's rows.
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, null=True, blank=True,
        related_name="jobs",
    )
    guest_session = models.ForeignKey(
        "core.GuestSession", on_delete=models.CASCADE, null=True, blank=True,
        related_name="jobs",
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
    # Structured detail for the §6 error shape. `text_overflow` is the reason it
    # exists: the client has to offer "shrink to N pt", and N is computed by the
    # engine — without somewhere to put it the number never leaves the worker.
    error_details = models.JSONField(default=dict, blank=True)
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
            models.Index(fields=["guest_session", "status"]),
        ]
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(user__isnull=False, guest_session__isnull=True)
                    | models.Q(user__isnull=True, guest_session__isnull=False)
                ),
                name="job_exactly_one_principal",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.type} [{self.status}] {self.id}"

    @property
    def principal(self):
        """The owning principal — use this, never `.user` directly (§21.2)."""
        return self.guest_session or self.user

    # --- lifecycle helpers (used by the worker, §11) ---
    def mark_running(self) -> None:
        self.status = self.Status.RUNNING
        self.started_at = timezone.now()
        self.save(update_fields=["status", "started_at"])

    def set_progress(self, pct: int) -> None:
        self.progress = max(0, min(100, int(pct)))
        self.save(update_fields=["progress"])

    def redacted_params(self) -> dict:
        """`params` with every secret replaced — what the API is allowed to show."""
        return {
            key: ("••••••" if key in self.SENSITIVE_PARAMS and value else value)
            for key, value in (self.params or {}).items()
        }

    def forget_secrets(self) -> None:
        """Drop password material from the row. Called on every terminal state."""
        params = self.params or {}
        if not any(key in params for key in self.SENSITIVE_PARAMS):
            return
        self.params = {k: v for k, v in params.items()
                       if k not in self.SENSITIVE_PARAMS}
        self.save(update_fields=["params"])

    def mark_succeeded(self, result: dict | None = None) -> None:
        self.status = self.Status.SUCCEEDED
        self.progress = 100
        self.result = result or {}
        self.finished_at = timezone.now()
        self.save(update_fields=["status", "progress", "result", "finished_at"])
        self.forget_secrets()

    def mark_failed(self, code: str, message: str, details: dict | None = None) -> None:
        self.status = self.Status.FAILED
        self.error_code = code
        self.error_message = message
        self.error_details = details or {}
        self.finished_at = timezone.now()
        self.save(update_fields=["status", "error_code", "error_message",
                                 "error_details", "finished_at"])
        self.forget_secrets()

    def mark_canceled(self) -> None:
        self.status = self.Status.CANCELED
        self.finished_at = timezone.now()
        self.save(update_fields=["status", "finished_at"])
        self.forget_secrets()

    @property
    def is_terminal(self) -> bool:
        return self.status in self.TERMINAL
