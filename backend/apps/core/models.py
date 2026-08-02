"""Shared cross-cutting models (01-architecture.md §9, §21)."""
from __future__ import annotations

import datetime as dt
import hashlib
import secrets
import uuid
from datetime import timedelta

from django.conf import settings
from django.db import models
from django.utils import timezone

TOKEN_BYTES = 32  # 256-bit raw token (§17a)


def hash_guest_token(raw_token: str) -> str:
    """sha256 of the raw token — the only form ever persisted (§9, §21.2)."""
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def hash_ip(ip: str | None) -> str:
    """Salted IP hash for abuse correlation only — never analytics, never
    user-facing, never in an ad payload (§17).

    The salt may be rotated, but no faster than GUEST_TTL_MAX_HOURS: sessions
    live at most that long, so a slower rotation only ever touches hashes that
    have already aged out. Rotating faster silently voids the IP leg of the
    guest throttle key for in-flight sessions.
    """
    if not ip:
        return ""
    salted = f"{settings.GUEST_IP_HASH_SALT}:{ip}".encode()
    return hashlib.sha256(salted).hexdigest()


class GuestSession(models.Model):
    """An anonymous principal (§21.2).

    Minted lazily on the first *write*, so a bounced visitor costs zero rows.
    The raw token is returned once, in the `X-Guest-Token` response header, and
    is never stored — only its sha256.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    token_hash = models.CharField(max_length=64, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)
    last_seen_at = models.DateTimeField(default=timezone.now)
    expires_at = models.DateTimeField(db_index=True)
    ip_hash = models.CharField(max_length=64, blank=True)
    user_agent = models.CharField(max_length=400, blank=True)
    storage_bytes_used = models.BigIntegerField(default=0)
    ops_count = models.IntegerField(default=0)
    captcha_passed_at = models.DateTimeField(null=True, blank=True)
    claimed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="claimed_guest_sessions",
    )
    claimed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"guest {self.id}"

    # --- lifecycle (§21.4) ---
    @staticmethod
    def new_raw_token() -> str:
        return secrets.token_urlsafe(TOKEN_BYTES)

    def _sliding_expiry(self, now: dt.datetime | None = None) -> dt.datetime:
        """last_seen + GUEST_TTL_HOURS, hard-capped at created + MAX (§21.4)."""
        now = now or timezone.now()
        sliding = now + timedelta(hours=settings.GUEST_TTL_HOURS)
        # created_at is unset until the first save; the cap starts from `now` then.
        created = self.created_at or now
        cap = created + timedelta(hours=settings.GUEST_TTL_MAX_HOURS)
        return min(sliding, cap)

    @classmethod
    def mint(cls, *, ip: str | None = None, user_agent: str = "") -> tuple[GuestSession, str]:
        """Create a session and return (session, raw_token).

        The raw token is the caller's only chance to see it.
        """
        raw = cls.new_raw_token()
        now = timezone.now()
        session = cls(
            token_hash=hash_guest_token(raw),
            last_seen_at=now,
            expires_at=now + timedelta(
                hours=min(settings.GUEST_TTL_HOURS, settings.GUEST_TTL_MAX_HOURS)
            ),
            ip_hash=hash_ip(ip),
            user_agent=(user_agent or "")[:400],
        )
        session.save()
        return session, raw

    @classmethod
    def resolve(cls, raw_token: str) -> GuestSession | None:
        if not raw_token:
            return None
        return cls.objects.filter(token_hash=hash_guest_token(raw_token)).first()

    @property
    def is_expired(self) -> bool:
        return self.expires_at <= timezone.now()

    @property
    def is_claimed(self) -> bool:
        return self.claimed_at is not None

    def touch(self) -> None:
        """Slide the TTL on every authenticated-as-guest request (§21.4)."""
        now = timezone.now()
        self.last_seen_at = now
        self.expires_at = self._sliding_expiry(now)
        type(self).objects.filter(pk=self.pk).update(
            last_seen_at=self.last_seen_at, expires_at=self.expires_at
        )

    def expire_now(self) -> None:
        """End the session server-side (used after a claim, §21.5)."""
        now = timezone.now()
        self.expires_at = now
        type(self).objects.filter(pk=self.pk).update(expires_at=now)


class UsageCounter(models.Model):
    """Monthly usage rollup for either principal (§9, §16).

    Month granularity only — per-hour/per-day windows are Redis throttle
    counters, never rows here.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, null=True, blank=True,
        related_name="usage_counters",
    )
    guest_session = models.ForeignKey(
        GuestSession, on_delete=models.CASCADE, null=True, blank=True,
        related_name="usage_counters",
    )
    period = models.CharField(max_length=7)  # "YYYY-MM"
    sign_requests = models.IntegerField(default=0)
    ocr_pages = models.IntegerField(default=0)
    conversions = models.IntegerField(default=0)
    heavy_ops = models.IntegerField(default=0)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["user", "period"], name="uniq_usage_user_period"),
            models.UniqueConstraint(
                fields=["guest_session", "period"], name="uniq_usage_guest_period"
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(user__isnull=False, guest_session__isnull=True)
                    | models.Q(user__isnull=True, guest_session__isnull=False)
                ),
                name="usage_exactly_one_principal",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.user_id or self.guest_session_id} {self.period}"


class EmailSuppression(models.Model):
    """Outbound-mail suppression list, honored by all mail (phase 9).

    Keyed on a keyed hash of the address rather than the address, because the
    unsubscribe link has to carry the key and a URL carrying somebody's email
    ends up in browser history, proxy logs and `Referer` headers — the same
    reason `users/verification.py` signs a user id. `email` is kept only when
    we already knew it (a staff suppression, a bounce), for the admin screen;
    a one-click unsubscribe leaves it blank because the token does not say.
    """

    REASONS = (
        ("complaint", "complaint"),
        ("unsubscribe", "unsubscribe"),
        ("bounce", "bounce"),
        ("manual", "manual"),
    )
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email_hash = models.CharField(max_length=64, unique=True)
    email = models.EmailField(blank=True, default="")
    reason = models.CharField(max_length=20, choices=REASONS)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        return f"{self.email or self.email_hash[:12]} ({self.reason})"
