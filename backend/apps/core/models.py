"""Shared cross-cutting models (01-architecture.md §9)."""
import uuid

from django.conf import settings
from django.db import models


class UsageCounter(models.Model):
    """Monthly per-user usage rollup (quotas §16)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="usage_counters"
    )
    period = models.CharField(max_length=7)  # "YYYY-MM"
    sign_requests = models.IntegerField(default=0)
    ocr_pages = models.IntegerField(default=0)
    conversions = models.IntegerField(default=0)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["user", "period"], name="uniq_usage_user_period"),
        ]

    def __str__(self) -> str:
        return f"{self.user_id} {self.period}"


class EmailSuppression(models.Model):
    """Outbound-mail suppression list, honored by all mail (phase 9)."""

    REASONS = (
        ("complaint", "complaint"),
        ("unsubscribe", "unsubscribe"),
        ("bounce", "bounce"),
        ("manual", "manual"),
    )
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email = models.EmailField(unique=True)
    reason = models.CharField(max_length=20, choices=REASONS)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        return f"{self.email} ({self.reason})"
