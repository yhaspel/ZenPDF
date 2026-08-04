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


def storage_used_fresh(principal) -> int:
    """`storage_used`, but from the database rather than the instance.

    `bump_storage` writes with `F()` and never refreshes the object it was
    handed, and a worker resolves its principal once per job — so inside a loop
    every iteration reads the value the *first* one saw. That made the quota
    check on `_create_document_from_bytes` decorative on exactly the path it was
    added for: `split` on a 2 000-page document passed iteration 1 on a genuine
    reading and iterations 2-2 000 on a stale one, and a single request took an
    account from under quota to nearly twice it. Measured before this existed:
    a three-page split saw `2898, 2898, 2898` while the row read
    `2898, 3769, 4639`.

    One extra `SELECT` per check, on a path that is about to write a blob.
    """
    if principal is None:
        return 0
    return type(principal).objects.filter(pk=principal.pk).values_list(
        "storage_bytes_used", flat=True).first() or 0


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


def ocr_pages_used_this_month(principal, *, period: str = "") -> int:
    """Pages OCR'd in the given month (default: this one)."""
    if principal is None:
        return 0
    from .models import UsageCounter
    from .principals import job_owner_kwargs

    row = UsageCounter.objects.filter(
        period=period or timezone.now().strftime("%Y-%m"),
        **job_owner_kwargs(principal),
    ).first()
    return row.ocr_pages if row else 0


def ocr_pages_used_today(principal) -> int:
    return int(cache.get(_window_key(principal, "ocrpages", _day_bucket()), 0))


def record_ocr_pages(principal, pages: int) -> None:
    """Charge OCR'd pages to both windows (§16).

    A guest's allowance is per *day* and an account's per *month*, so both are
    kept: the daily figure in Redis beside the other short windows, the monthly
    one in `core.UsageCounter` where it survives a Redis flush.
    """
    pages = max(0, int(pages))
    if principal is None or not pages:
        return
    key = _window_key(principal, "ocrpages", _day_bucket())
    try:
        cache.incr(key, pages)
    except ValueError:
        # 26 h, so a window opened at 23:59 still expires cleanly.
        cache.set(key, pages, timeout=93600)
    bump_monthly(principal, ocr_pages=pages)


def enforce_storage(principal, incoming_bytes: int) -> None:
    """Charge `incoming_bytes` against the storage quota, or raise (§16).

    Four paths already read the quota before writing: upload
    (`documents/views.py`), image assets and conversion sources
    (`core/assets.py`), and claim (`core/claim.py`). Two wrote without reading
    it — `_save_new_version` and `_create_document_from_bytes` both called
    `bump_storage` and never looked at the result, so a principal already past
    their quota kept minting versions *and* whole documents. Both now call this;
    `test_version_quota.py` covers each.

    One path is still deliberately unmetered-at-the-door: `_save_export` charges
    for the artefact but does not refuse. An export is the escape hatch — it is
    how somebody over quota gets their work out before deleting something — and
    it deletes itself in 24 h. Refusing it would strand the account. Written
    down because "all the doors are shut" is the sentence that stops the next
    reader looking.

    This is also what `version_retention` was reaching for and could not hold: a
    per-*document* cap does not bound a per-*principal* cost, because fifty
    versions each of unlimited documents is still unlimited. The quota does
    bound it, is already published, is already on the usage panel, and — unlike
    a pruned history — the user can clear it by deleting something.
    """
    if principal is None or incoming_bytes <= 0:
        return
    from .exceptions import QuotaExceeded

    tier = for_principal(principal)
    used = storage_used_fresh(principal)
    if used + incoming_bytes <= tier.storage_bytes:
        return
    exc = QuotaExceeded(
        f"That would take you past your {tier.storage_bytes // (1024 * 1024)} MB "
        "of storage. Empty your trash or delete a document to free some up."
        + (" Creating a free account gives you 2 GB."
           if tier.tier == "guest" else "")
    )
    exc.zen_details = {
        "quota_bytes": tier.storage_bytes,
        "used_bytes": used,
        "requested_bytes": incoming_bytes,
        "tier": tier.tier,
    }
    raise exc


def enforce_ocr_pages(principal, pages: int) -> None:
    """Charge `pages` against the OCR page quota, or raise (§16).

    A page-count pre-check rather than a post-hoc tally: OCR is the most
    expensive thing we do, and a 300-page document should be refused *before*
    a worker spends ten minutes on it. The limit is advertised in
    `/api/config/` and on the usage panel, so leaving it unenforced would make
    both of those a claim rather than a fact.

    §16 states the guest allowance per day and the account allowance per month;
    a tier whose row is 0 simply has no limit on that window.
    """
    from .exceptions import QuotaExceeded

    tier = for_principal(principal)
    wanted = max(0, int(pages))
    windows = (
        ("day", tier.ocr_pages_per_day, ocr_pages_used_today(principal)),
        ("month", tier.ocr_pages_per_month, ocr_pages_used_this_month(principal)),
    )
    for window, limit, used in windows:
        if not limit or used + wanted <= limit:
            continue
        exc = QuotaExceeded(
            f"That would take you past your {limit} OCR pages for this {window} "
            f"(you have used {used})."
            + (" Create a free account for a higher limit."
               if tier.tier == "guest" else "")
        )
        exc.zen_details = {
            "limit": limit, "used": used, "requested": wanted,
            "window": window, "tier": tier.tier,
        }
        raise exc


# --------------------------------------------------------------------------- #
# Wrong-password attempts (phase-07, §17)
# --------------------------------------------------------------------------- #
PASSWORD_ATTEMPTS_PER_MINUTE = 5
PASSWORD_ATTEMPT_WINDOW_SECONDS = 60
#: How finely the window slides. Six ten-second buckets make a minute that
#: *moves*, which is what a calendar minute did not: five wrong guesses at
#: 12:00:59 and five more at 12:01:00 was ten in one second, and the meter said
#: five each time. Ten seconds is a compromise — one key per bucket to read, and
#: the effective window is 60–70 s rather than exactly 60 (L5, BUG-4).
PASSWORD_ATTEMPT_BUCKET_SECONDS = 10


def _password_keys(document_id) -> list[str]:
    """The sub-buckets covering the last minute, newest first."""
    now = int(timezone.now().timestamp()) // PASSWORD_ATTEMPT_BUCKET_SECONDS
    span = PASSWORD_ATTEMPT_WINDOW_SECONDS // PASSWORD_ATTEMPT_BUCKET_SECONDS
    return [f"zen:pwfail:{document_id}:{now - offset}" for offset in range(span)]


def record_password_failure(document_id) -> None:
    """Count one wrong password against this document's sliding minute."""
    key = _password_keys(document_id)[0]
    try:
        cache.incr(key)
    except ValueError:
        # Live long enough to still be counted from the far end of the window.
        cache.set(key, 1, timeout=PASSWORD_ATTEMPT_WINDOW_SECONDS * 3)


def password_failures_in_window(document_id) -> int:
    keys = _password_keys(document_id)
    return sum(int(value or 0) for value in cache.get_many(keys).values())


def enforce_password_attempts(document_id) -> None:
    """Refuse further attempts after five wrong passwords in a minute.

    Per *document*, not per principal: the thing being guessed at is one
    document's password, and an attacker who could open several sessions would
    otherwise get five tries each. The window is short — this is meant to make
    brute force pointless, not to lock out the owner who mistyped.

    It also *slides*. The other meters in this module use fixed calendar
    windows, which allow a 2× burst across the boundary; that is tolerable for
    an hourly op budget and is not tolerable for the one meter standing between
    an attacker and a document password.
    """
    from .exceptions import QuotaExceeded

    used = password_failures_in_window(document_id)
    if used < PASSWORD_ATTEMPTS_PER_MINUTE:
        return
    exc = QuotaExceeded(
        "Too many incorrect passwords for this document. Wait a minute and try again."
    )
    exc.zen_details = {"limit": PASSWORD_ATTEMPTS_PER_MINUTE, "used": used,
                       "window": "minute"}
    raise exc


def sign_requests_used_this_month(principal) -> int:
    if principal is None:
        return 0
    from .models import UsageCounter
    from .principals import job_owner_kwargs

    row = UsageCounter.objects.filter(
        period=timezone.now().strftime("%Y-%m"), **job_owner_kwargs(principal),
    ).first()
    return row.sign_requests if row else 0


def record_sign_request(principal) -> None:
    bump_monthly(principal, sign_requests=1)


def enforce_sign_requests(principal) -> None:
    """The monthly signature-request quota (§16, phase-08 criterion 7).

    A guest's row is 0, which is `account_required` rather than
    `quota_exceeded` — the guest cannot send one at all, and telling them they
    are out of allowance would be a lie about a feature they never had.
    """
    from .exceptions import AccountRequired, QuotaExceeded

    tier = for_principal(principal)
    if not tier.sign_requests_per_month:
        raise AccountRequired(
            "Create a free account to send a document for signature. Signing "
            "one yourself needs no account."
        )
    used = sign_requests_used_this_month(principal)
    if used >= tier.sign_requests_per_month:
        exc = QuotaExceeded(
            f"You have sent your {tier.sign_requests_per_month} signature "
            f"requests for this month."
        )
        exc.zen_details = {"limit": tier.sign_requests_per_month, "used": used,
                           "window": "month", "tier": tier.tier}
        raise exc


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
