"""Claim-on-signup (01-architecture.md §21.5).

The single most valuable moment in the funnel: the work a guest already did
follows them into the account they just created.

Metadata-only reparent — blob keys are principal-independent (§13), so nothing
is copied. One transaction, idempotent, and it moves **every principal-bearing
row**, not just documents:

  * `Document`  — an in-flight document left behind is the file they signed up
    to keep.
  * `Job`       — a job left guest-owned drops out of `owned_by(qs, user)` the
    instant they register, so the poll on that exact file dies mid-operation.
  * `UsageCounter` — counters left behind let a monthly quota be reset by
    laundering work through a guest session. Rule: **sum**.
  * `GuestSession` — expired server-side afterwards, so `guest_purge` can never
    cascade into rows the user now owns.
"""
from __future__ import annotations

from django.db import transaction
from django.db.models import F, Sum
from django.utils import timezone

from .exceptions import QuotaExceeded
from .limits import for_principal
from .models import GuestSession, UsageCounter

COUNTER_FIELDS = ("sign_requests", "ocr_pages", "conversions", "heavy_ops")


def preflight(session: GuestSession, user) -> dict:
    """What a claim would transfer, and whether it fits the user's quota.

    Returns a summary dict; raises `quota_exceeded` **listing the overflow**
    rather than claiming part of it. Never partially claim, never silently drop
    files (§21.5).
    """
    from apps.documents.models import Document
    from apps.jobs.models import Job

    documents = Document.objects.filter(guest_session=session)
    # Measure what is actually transferred: `session.storage_bytes_used` is the
    # counter folded into `User.storage_bytes_used`, and it accounts for *every*
    # version blob. Summing `Document.size_bytes` would only see current
    # versions, so a session with edit history could pass this check and still
    # push the account over its quota.
    incoming_bytes = int(session.storage_bytes_used)
    summary = {
        "documents": documents.count(),
        "jobs": Job.objects.filter(guest_session=session).count(),
        "bytes": incoming_bytes,
        "current_version_bytes": int(
            documents.aggregate(total=Sum("size_bytes"))["total"] or 0
        ),
    }

    limits = for_principal(user)
    projected = user.storage_bytes_used + incoming_bytes
    if projected > limits.storage_bytes:
        overflow = projected - limits.storage_bytes
        exc = QuotaExceeded(
            f"Claiming these {summary['documents']} file(s) would exceed your storage "
            f"quota by {overflow // 1024} KB. Nothing was transferred — free up space "
            f"and try again."
        )
        exc.zen_details = {
            "would_transfer": summary,
            "quota_bytes": limits.storage_bytes,
            "used_bytes": user.storage_bytes_used,
            "overflow_bytes": overflow,
            "items": [
                {"id": str(d.id), "title": d.title, "size_bytes": d.size_bytes}
                for d in documents.only("id", "title", "size_bytes")
            ],
        }
        raise exc
    return summary


@transaction.atomic
def claim_session(session: GuestSession, user) -> dict:
    """Reparent everything this session owns onto `user`. Idempotent.

    Re-claiming an already-claimed session by the same user is a no-op that
    reports zero moved rows; a different user gets nothing (the rows are gone
    from the session by then anyway).
    """
    from apps.documents.models import Document
    from apps.jobs.models import Job

    # Lock the session row so two concurrent claims cannot both pass preflight
    # and double-count storage.
    session = GuestSession.objects.select_for_update().get(pk=session.pk)

    if session.claimed_at is not None:
        return {
            "documents": 0, "jobs": 0, "bytes": 0,
            "current_version_bytes": 0, "already_claimed": True,
        }

    summary = preflight(session, user)

    # 1. Documents: owner set, guest_session and the guest TTL cleared.
    Document.objects.filter(guest_session=session).update(
        owner=user, guest_session=None, expires_at=None
    )
    # 2. Jobs: non-optional — see the module docstring.
    Job.objects.filter(guest_session=session).update(user=user, guest_session=None)
    # 3. Usage counters: fold into the user's row for the same period. The
    #    unique(user, period) constraint means this is a merge, never an insert.
    for counter in UsageCounter.objects.filter(guest_session=session):
        target, _ = UsageCounter.objects.get_or_create(user=user, period=counter.period)
        UsageCounter.objects.filter(pk=target.pk).update(
            **{f: F(f) + getattr(counter, f) for f in COUNTER_FIELDS}
        )
        counter.delete()
    # 4. Session: mark claimed, fold storage into the user, and expire it so
    #    guest_purge can never cascade into the rows above.
    now = timezone.now()
    type(user).objects.filter(pk=user.pk).update(
        storage_bytes_used=F("storage_bytes_used") + session.storage_bytes_used
    )
    GuestSession.objects.filter(pk=session.pk).update(
        claimed_by=user, claimed_at=now, storage_bytes_used=0, expires_at=now
    )
    # `uploads/…` is the one namespace keyed by *principal* rather than by
    # document (§13), so it is the one thing a metadata-only reparent misses.
    # Left behind, a guest's stamps sit under a prefix that `guest_purge`
    # deletes within the hour — and the session was just expired above, so that
    # sweep is imminent. Re-key them onto the account instead.
    from .assets import move_assets

    summary["assets"] = move_assets("g", session.id, user)
    user.refresh_from_db(fields=["storage_bytes_used"])

    summary["already_claimed"] = False
    return summary


def claim_if_token(request, user) -> dict | None:
    """Claim inline on register/login when an `X-Guest-Token` is present (§21.5).

    Returns the summary, or None when there was nothing to claim. A stale or
    unknown token is *not* an error here: the account was still created, and
    failing the signup over a dead guest session would be the worst possible
    trade.
    """
    from .authentication import raw_guest_token

    token = raw_guest_token(request)
    if not token:
        return None
    session = GuestSession.resolve(token)
    if session is None or session.is_claimed:
        return None
    return claim_session(session, user)
