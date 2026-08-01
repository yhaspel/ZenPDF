"""Custom email-login User (01-architecture.md §9).

Created before the first migration (skill rule #1). Email is normalized to
lowercase on save, giving case-insensitive uniqueness via the unique index.
"""
import uuid

from django.contrib.auth.models import AbstractUser
from django.db import models

from .managers import UserManager


class User(AbstractUser):
    class Plan(models.TextChoices):
        FREE = "free"
        PRO = "pro"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    username = None  # login is by email
    email = models.EmailField(unique=True)
    display_name = models.CharField(max_length=150, blank=True)
    email_verified = models.BooleanField(default=False)
    accepted_tos_at = models.DateTimeField(null=True, blank=True)
    storage_bytes_used = models.BigIntegerField(default=0)
    # Tier selector for core.limits.for_principal (§16). `pro` is a config row
    # only: no billing, no checkout, no upgrade UI in v1 — settable through
    # Django admin alone (§21.7).
    plan = models.CharField(max_length=12, choices=Plan.choices, default=Plan.FREE)

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = []

    objects = UserManager()

    def save(self, *args, **kwargs):
        if self.email:
            self.email = self.email.lower()
        super().save(*args, **kwargs)

    def __str__(self) -> str:
        return self.email
