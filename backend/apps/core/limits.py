"""Tier-resolved limits — the single source of truth (01-architecture.md §16).

No call site hardcodes a limit; every quota check resolves through
`for_principal()`. That is also why the `pro` tier exists as a config row with
no billing behind it (§21.7): adding billing later is "write a plan field",
not a refactor of every check.
"""
from __future__ import annotations

from dataclasses import dataclass

from django.conf import settings
from django.core.cache import cache
from django.utils import timezone

from .principals import is_guest

# ⚠ METERED_OPS is NOT the `heavy` Celery queue (§16, §17).
#
# The heavy queue also holds merge, alternate_mix, compress and repair — the
# flagship tool pages (/merge-pdf, /compress-pdf). Deriving the guest rate cap
# or the Turnstile challenge from `op.queue` would put a CAPTCHA in front of a
# guest's first merge, which is the exact outcome §21.1 exists to prevent.
# Queue membership is worker sizing; this set is cost control. Different sets,
# deliberately. `test_limits.py` asserts they stay disjoint.
METERED_OPS = frozenset({"ocr", "convert_from", "convert_to", "compare"})


@dataclass(frozen=True)
class Limits:
    """Resolved limits for one principal. Frozen: a limit is never mutated in
    flight, only re-resolved."""

    tier: str
    storage_bytes: int
    max_upload_bytes: int
    # Images uploaded as stamps/watermarks/signatures (§13 `uploads/…`), not PDFs.
    max_image_upload_bytes: int
    max_pages: int
    max_concurrent_jobs: int
    metered_ops_per_hour: int
    ocr_pages_per_day: int
    ocr_pages_per_month: int
    sign_requests_per_month: int
    version_retention: int
    library: bool
    ads: bool

    def as_api_dict(self) -> dict:
        """The shape `/api/config/` and the SPA consume (§16)."""
        return {
            "tier": self.tier,
            "storage_mb": self.storage_bytes // (1024 * 1024),
            "max_upload_mb": self.max_upload_bytes // (1024 * 1024),
            "max_image_upload_mb": self.max_image_upload_bytes // (1024 * 1024),
            "max_pages": self.max_pages,
            "max_concurrent_jobs": self.max_concurrent_jobs,
            "metered_ops_per_hour": self.metered_ops_per_hour,
            "ocr_pages_per_day": self.ocr_pages_per_day,
            "ocr_pages_per_month": self.ocr_pages_per_month,
            "sign_requests_per_month": self.sign_requests_per_month,
            "version_retention": self.version_retention,
            "library": self.library,
            "ads": self.ads,
        }


def tier_of(principal) -> str:
    """GuestSession → 'guest'; User → user.plan (default 'free'); None → 'guest'.

    An unauthenticated reader is quoted guest limits because that is what it
    would get the moment it writes anything (minting is lazy, §21.2).
    """
    if principal is None:
        return "guest"
    if is_guest(principal):
        return "guest"
    plan = getattr(principal, "plan", "") or "free"
    return plan if plan in settings.TIERS else "free"


def for_tier(tier: str) -> Limits:
    row = settings.TIERS.get(tier) or settings.TIERS["free"]
    return Limits(
        tier=tier,
        storage_bytes=row["storage_mb"] * 1024 * 1024,
        max_upload_bytes=row["max_upload_mb"] * 1024 * 1024,
        max_image_upload_bytes=row["max_image_upload_mb"] * 1024 * 1024,
        max_pages=row["max_pages"],
        max_concurrent_jobs=row["max_concurrent_jobs"],
        metered_ops_per_hour=row["metered_ops_per_hour"],
        ocr_pages_per_day=row["ocr_pages_per_day"],
        ocr_pages_per_month=row["ocr_pages_per_month"],
        sign_requests_per_month=row["sign_requests_per_month"],
        version_retention=row["version_retention"],
        library=row["library"],
        ads=row["ads"],
    )


def for_principal(principal) -> Limits:
    """The one function every quota check goes through (§16)."""
    return for_tier(tier_of(principal))


# --------------------------------------------------------------------------- #
# Storage accounting — the principal's own counter, never `User` unconditionally
# --------------------------------------------------------------------------- #
def storage_used(principal) -> int:
    if principal is None:
        return 0
    return principal.storage_bytes_used


def bump_storage(principal, delta: int) -> None:
    """Add `delta` bytes to the principal's denormalized counter.

    Written as an UPDATE against the principal's *own* table. The pre-2B code
    always wrote `users`, which for a guest job became
    `UPDATE users … WHERE id IS NULL` — a silent no-op that made the guest cap
    unenforceable.
    """
    if principal is None or not delta:
        return
    bump_storage_by_id(
        "guest" if is_guest(principal) else "user", principal.pk, delta
    )


def bump_storage_by_id(kind: str, pk, delta: int) -> None:
    """`bump_storage` for a worker that has ids but not model instances."""
    if not delta or pk is None:
        return
    from django.db.models import F

    if kind == "guest":
        from .models import GuestSession

        GuestSession.objects.filter(pk=pk).update(
            storage_bytes_used=F("storage_bytes_used") + delta
        )
    else:
        from django.contrib.auth import get_user_model

        get_user_model().objects.filter(pk=pk).update(
            storage_bytes_used=F("storage_bytes_used") + delta
        )


# --------------------------------------------------------------------------- #
# Short-window metering (Redis counters, NOT UsageCounter rows — §16)
# --------------------------------------------------------------------------- #
def _principal_key(principal) -> str:
    if principal is None:
        return "none"
    return f"{'g' if is_guest(principal) else 'u'}:{principal.pk}"


def _window_key(principal, name: str, bucket: str) -> str:
    return f"zen:meter:{name}:{_principal_key(principal)}:{bucket}"


def _hour_bucket() -> str:
    return timezone.now().strftime("%Y%m%d%H")


def _day_bucket() -> str:
    return timezone.now().strftime("%Y%m%d")


def metered_ops_used_this_hour(principal) -> int:
    return int(cache.get(_window_key(principal, "metered", _hour_bucket()), 0))


def record_metered_op(principal) -> None:
    """Increment the hourly Redis window and the monthly `heavy_ops` row.

    A Redis flush resets the in-flight rate window; the monthly figure survives
    in Postgres because it lives in `core.UsageCounter` (§16).
    """
    key = _window_key(principal, "metered", _hour_bucket())
    try:
        cache.incr(key)
    except ValueError:
        # `incr` raises when the key is absent; seed it with a 2 h TTL so a
        # window started at :59 still expires cleanly.
        cache.set(key, 1, timeout=7200)
    bump_monthly(principal, heavy_ops=1)


def bump_monthly(principal, **fields: int) -> None:
    """`get_or_create` + F() increments on the principal's month row (§9)."""
    if principal is None or not fields:
        return
    from django.db.models import F

    from .models import UsageCounter
    from .principals import job_owner_kwargs

    period = timezone.now().strftime("%Y-%m")
    counter, _ = UsageCounter.objects.get_or_create(
        period=period, **job_owner_kwargs(principal)
    )
    UsageCounter.objects.filter(pk=counter.pk).update(
        **{name: F(name) + amount for name, amount in fields.items()}
    )


def is_metered(op_type: str) -> bool:
    return op_type in METERED_OPS


def enforce_metered_op(principal, op_type: str) -> None:
    """Charge one metered op against the hourly window, or raise.

    A no-op for every non-metered op — which is every op a guest is likely to
    run first (merge, split, compress, rotate…). Metering those would defeat the
    strategy (§21.1); see the METERED_OPS note above.
    """
    if not is_metered(op_type):
        return
    from .exceptions import QuotaExceeded

    tier = for_principal(principal)
    used = metered_ops_used_this_hour(principal)
    if used >= tier.metered_ops_per_hour:
        exc = QuotaExceeded(
            f"You have used your {tier.metered_ops_per_hour} heavy operations for this hour."
            + (" Create a free account for a higher limit."
               if tier.tier == "guest" else "")
        )
        exc.zen_details = {
            "limit": tier.metered_ops_per_hour,
            "used": used,
            "window": "hour",
            "tier": tier.tier,
        }
        raise exc
    record_metered_op(principal)
