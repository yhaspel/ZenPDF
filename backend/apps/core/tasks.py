"""Beat tasks owned by core (01-architecture.md §15, §21.4).

`exports_purge` enforces the §15 export TTL, and `guest_purge` runs hourly and
**hard-deletes** expired guest sessions: their
documents, versions, thumbnails and the storage blobs behind all of it. No soft
delete, no trash — for a guest, expiry means gone. That is a feature to
advertise ("no account, files auto-deleted within 24 hours"), and it is what
bounds both anonymous storage cost and breach blast radius.
"""
from __future__ import annotations

import logging

from celery import shared_task
from django.conf import settings
from django.core.exceptions import ValidationError
from django.utils import timezone

logger = logging.getLogger("zenpdf")


def _purge_session_exports(session) -> int:
    """`exports/{job_id}/` for every job this guest session owns."""
    from apps.jobs.models import Job
    from apps.pdf_engine.storage import get_storage

    storage = get_storage()
    removed = 0
    for job_id in Job.objects.filter(guest_session=session).values_list("id", flat=True):
        try:
            removed += storage.delete_prefix(f"exports/{job_id}/")
        except Exception:  # noqa: BLE001
            logger.warning("guest_purge: could not delete exports/%s/", job_id)
    return removed


def _purge_document_blobs(document) -> int:
    """Delete every blob belonging to one document: version PDFs *and*
    thumbnails.

    Thumbnails are keyed `thumbs/{doc}/{seq}/p{n}@{w}.png` — the page/width
    combinations that were actually rendered are not recoverable from the DB, so
    they go by prefix. Deleting only the rows' `storage_key` values would leave
    every thumbnail orphaned in the bucket forever.
    """
    from apps.pdf_engine.storage import get_storage

    storage = get_storage()
    removed = 0
    for version in document.versions.all():
        try:
            storage.delete(version.storage_key)
            removed += 1
        except Exception:  # noqa: BLE001
            logger.warning("guest_purge: could not delete %s", version.storage_key)
    try:
        removed += storage.delete_prefix(f"docs/{document.id}/")
        removed += storage.delete_prefix(f"thumbs/{document.id}/")
    except Exception:  # noqa: BLE001
        logger.warning("guest_purge: prefix sweep failed for document %s", document.id)
    return removed


@shared_task(name="apps.core.tasks.guest_purge")
def guest_purge() -> dict:
    """Hard-delete expired guest sessions and everything they own."""
    from apps.documents.models import Document

    from .models import GuestSession

    now = timezone.now()
    expired = GuestSession.objects.filter(expires_at__lte=now)
    stats = {"sessions": 0, "documents": 0, "blobs": 0}

    for session in expired:
        # Only rows still pointing at the session are touched. A claimed
        # session's documents were reparented onto the account in the claim
        # transaction, so this can never cascade into rows a user now owns
        # (§21.5) — but scoping the query to `guest_session=session` is what
        # actually guarantees that, not the ordering.
        documents = Document.objects.filter(guest_session=session)
        for document in documents:
            stats["blobs"] += _purge_document_blobs(document)
            # Break the self-reference before the versions go.
            document.current_version = None
            document.save(update_fields=["current_version"])
            document.delete()
            stats["documents"] += 1
        # Ephemeral image assets (custom stamps, watermarks, signatures) live
        # outside the document tree at `uploads/g/{session}/…` (§13), so the
        # document sweep above cannot reach them.
        from .assets import purge_principal_assets

        stats["blobs"] += purge_principal_assets("g", session.id)
        # Export artefacts are keyed by *job*, and the job rows cascade away
        # with the session row below — so they must go first or nothing can
        # find them again. `exports_purge` sweeps by age and would never see
        # them: the rows it iterates are gone. This is what makes "files
        # auto-deleted within 24 hours" true for an export too (§21.4).
        stats["blobs"] += _purge_session_exports(session)
        # Jobs and usage counters cascade from the session row itself.
        session.delete()
        stats["sessions"] += 1

    if stats["sessions"]:
        logger.info(
            "guest_purge: removed %(sessions)s session(s), %(documents)s document(s), "
            "%(blobs)s blob(s)", stats,
        )
    return stats


@shared_task(name="apps.core.tasks.exports_purge")
def exports_purge() -> dict:
    """Delete export artefacts older than the §15 TTL (24 h).

    Exports are the one namespace with no row pointing at it: `convert_to`
    writes `exports/{job_id}/{filename}` and the Job's `result` remembers the
    key, but nothing ever deletes it. Without this the bucket grows for ever —
    and the storage is charged against the principal's quota, so a user who
    exported a large document once would carry that cost permanently.

    The UI says "kept for 24 hours, then deleted" on two screens. This is the
    task that makes that true rather than a claim.
    """
    from datetime import timedelta

    from apps.core import limits as L
    from apps.jobs.models import Job
    from apps.pdf_engine.storage import get_storage

    cutoff = timezone.now() - timedelta(hours=settings.EXPORT_TTL_HOURS)
    storage = get_storage()
    stats = {"jobs": 0, "blobs": 0, "bytes": 0}

    stale = Job.objects.filter(
        type="convert_to", finished_at__lt=cutoff, result__has_key="export",
    )
    for job in stale.iterator():
        export = (job.result or {}).get("export") or {}
        key = export.get("storage_key")
        if not key:
            continue
        try:
            removed = storage.delete_prefix(f"exports/{job.id}/")
        except Exception:  # noqa: BLE001
            logger.warning("exports_purge: could not delete exports/%s/", job.id)
            continue
        if not removed:
            continue
        # Give the quota back — `_save_export` charged it on the way in.
        L.bump_storage(job.principal, -int(export.get("size_bytes") or 0))
        stats["blobs"] += removed
        stats["bytes"] += int(export.get("size_bytes") or 0)
        stats["jobs"] += 1
        # The artefact is gone; the job must stop advertising a download.
        job.result = {k: v for k, v in (job.result or {}).items() if k != "export"}
        job.save(update_fields=["result"])

    if stats["jobs"]:
        logger.info("exports_purge: removed %(blobs)s blob(s) from %(jobs)s job(s)", stats)
    stats["previews"] = redaction_previews_purge()
    return stats


@shared_task(name="apps.core.tasks.job_params_purge")
def job_params_purge(days: int | None = None) -> int:
    """Drop the *inputs* of finished jobs. Keep the row.

    Not a retention policy — the row, its type, status and timestamps stay, so
    Settings → Recent jobs is unchanged and nothing the user can see
    disappears. What goes is the content-derived half: the patterns somebody
    redacted for, the replacement text they typed, the page lists they chose.

    That is the same reasoning `redaction_previews_purge` applies at one hour
    to `redact` jobs alone, applied to every type at a month. Passwords are
    already dropped the moment a job finishes (`Job.SENSITIVE_PARAMS`); this is
    everything else, which is not a credential but is still a record of what
    was in somebody's document.

    `result` is deliberately untouched: `exports/{job_id}/` is reachable only
    through `result["export"]`, and `exports_purge` is the only thing that can
    delete that blob.
    """
    from datetime import timedelta

    from apps.jobs.models import Job

    window = settings.JOB_PARAMS_RETENTION_DAYS if days is None else days
    cutoff = timezone.now() - timedelta(days=window)
    cleaned = Job.objects.filter(
        status__in=Job.TERMINAL, finished_at__lt=cutoff,
    ).exclude(params={}).update(params={})
    if cleaned:
        logger.info("job_params_purge: cleared params on %s job(s)", cleaned)
    return cleaned


@shared_task(name="apps.core.tasks.jobs_purge")
def jobs_purge(days: int | None = None) -> dict:
    """Delete finished job rows past `JOB_RETENTION_DAYS`.

    Why a year, when trash is thirty days: a job row is *our* record of an
    operation, not the user's file, and the only place it surfaces is the
    twenty-row panel in Settings. A month would be enough for support and
    invisible to everybody — but the reason this exists is that the table grows
    without bound, and the measured cost today is noise (a few hundred
    kilobytes, seven buffers on the reaper's scan). So the window is set where
    nobody can observe the deletion rather than where it is merely defensible.

    **The export prefix goes first.** `exports_purge` finds stale artefacts by
    iterating Job rows; once the row is gone the blob is unreachable for ever —
    the same trap `guest_purge` and account deletion already had to write down.
    Normally `exports_purge` stripped the key 364 days earlier and this matches
    nothing; when it does match, the bytes are refunded here, because deleting
    the row loses the only record that the charge was made.
    """
    from datetime import timedelta

    from apps.core import limits as L
    from apps.jobs.models import Job
    from apps.pdf_engine.storage import get_storage

    window = settings.JOB_RETENTION_DAYS if days is None else days
    cutoff = timezone.now() - timedelta(days=window)
    storage = get_storage()
    stats = {"jobs": 0, "blobs": 0, "kept": 0}

    stale = Job.objects.filter(status__in=Job.TERMINAL, finished_at__lt=cutoff)
    for job in stale.iterator():
        export = (job.result or {}).get("export") or {}
        if export.get("storage_key"):
            try:
                removed = storage.delete_prefix(f"exports/{job.id}/")
            except Exception:  # noqa: BLE001
                # Leave the row for tomorrow rather than deleting the blob's
                # only pointer.
                logger.warning("jobs_purge: could not delete exports/%s/", job.id)
                stats["kept"] += 1
                continue
            # Refund only what this call actually freed — the same guard
            # `exports_purge` carries, and for a sharper reason here. That task
            # refunds and *then* saves the stripped `result` in two steps with
            # no transaction: a worker that dies between them leaves a row
            # still advertising a `storage_key` whose blob is already gone and
            # already credited. Refunding on the key rather than on the delete
            # would charge that account twice, and `bump_storage` has no floor.
            if removed:
                stats["blobs"] += removed
                L.bump_storage(job.principal, -int(export.get("size_bytes") or 0))
        job.delete()
        stats["jobs"] += 1

    if stats["jobs"] or stats["kept"]:
        logger.info("jobs_purge: removed %(jobs)s job(s), %(blobs)s blob(s), "
                    "kept %(kept)s", stats)
    return stats


@shared_task(name="apps.core.tasks.trash_purge")
def trash_purge() -> dict:
    """Delete documents that have been in the trash past the retention window.

    §15 lists this task and the privacy policy quotes its number. Both are read
    from `TRASH_RETENTION_DAYS`, and a test asserts the policy, the setting and
    this task agree — a retention promise nobody checks is the kind of sentence
    that quietly stops being true.
    """
    from datetime import timedelta

    from apps.core.exceptions import ValidationFailed
    from apps.documents.models import Document
    from apps.documents.views import DocumentDetailView

    cutoff = timezone.now() - timedelta(days=settings.TRASH_RETENTION_DAYS)
    stale = Document.objects.filter(trashed_at__isnull=False,
                                    trashed_at__lt=cutoff)
    purged, kept, failed = 0, 0, 0
    for document in stale.iterator():
        try:
            DocumentDetailView._purge(document)
            purged += 1
        except ValidationFailed:
            # A document under a signature request refuses deletion by design
            # (phase-08) — that is a reason to leave it, not to fail the sweep.
            # The privacy policy says so in as many words, because a retention
            # promise with a silent exception is not a promise.
            kept += 1
            logger.info("trash_purge: kept %s (still referenced)", document.id)
        except Exception:  # noqa: BLE001
            # Anything else is a storage or database fault, and counting it as
            # "kept" would hide a sweep that is quietly failing every night.
            failed += 1
            logger.exception("trash_purge: failed on %s", document.id)
    if purged or kept or failed:
        logger.info("trash_purge: removed %s, kept %s, failed %s",
                    purged, kept, failed)
    return {"purged": purged, "kept": kept, "failed": failed}


# --------------------------------------------------------------------------- #
# Storage-counter reconciliation (§15)
# --------------------------------------------------------------------------- #
#: Drift smaller than this is not reported. Not a tolerance — the counter is
#: still corrected — just a noise floor for the log, so a real 400 MB divergence
#: is not buried under a hundred one-byte lines.
DRIFT_LOG_FLOOR_BYTES = 1024


def charged_bytes(principal) -> int:
    """What `principal.storage_bytes_used` *should* read, from what is charged.

    Three namespaces bill against the quota, and this has to agree with every
    task that credits them back or the reconciler becomes the drift:

    1. **Version blobs** — `DocumentVersion.size_bytes` for every document the
       principal owns, **trashed included**. Trash still costs until it is
       purged: `DocumentDetailView._purge` is the only thing that credits the
       bytes back, and `trash_purge` does not call it until the retention
       window is up. A reconciler that excluded trashed documents would delete
       the charge thirty days early and hand everyone free storage.

    2. **`uploads/{u|g}/{id}/`** — stamps, watermarks, conversion sources *and*
       saved signatures (§13: a `SavedSignature.storage_key` is an asset key in
       this very prefix, not a namespace of its own). These blobs have no rows
       at all — the ref is opaque and nothing records a size — so the only
       honest answer is to add up what is actually in the prefix.

    3. **Live exports** — `exports/{job_id}/`. Presence is read from *storage*,
       not from `result["export"]["storage_key"]`, and the amount from the row.
       That is exactly `jobs_purge`'s rule, and it is deliberate: `exports_purge`
       refunds and then strips the key in two un-transacted steps, so a worker
       killed between them leaves a row still advertising a key whose blob is
       gone and already credited. Counting the key would re-charge it for ever.

    Not counted, because nothing charges them: `thumbs/…` (rendered on demand,
    §13) and `sign/{request}/…` (the sealed file and certificate are the
    counterparty's evidence, and `_finalize` never calls `bump_storage`).
    """
    from django.db.models import Sum

    from apps.documents.models import Document, DocumentVersion
    from apps.jobs.models import Job
    from apps.pdf_engine.storage import get_storage

    from .assets import principal_prefix
    from .principals import owned_by

    storage = get_storage()
    total = 0

    documents = owned_by(Document.objects.all(), principal)
    total += int(
        DocumentVersion.objects.filter(document__in=documents)
        .aggregate(total=Sum("size_bytes"))["total"] or 0
    )

    total += sum(int(entry["size"] or 0)
                 for entry in storage.list_prefix_detailed(principal_prefix(principal)))

    jobs = owned_by(Job.objects.all(), principal).filter(result__has_key="export")
    for job in jobs.iterator():
        export = (job.result or {}).get("export") or {}
        if not export.get("storage_key"):
            continue
        if storage.list_prefix(f"exports/{job.id}/"):
            total += int(export.get("size_bytes") or 0)
    return total


def _has_work_in_flight(principal) -> bool:
    """A queued or running job means the counter is mid-flight.

    `_save_new_version` charges before the row is visible to us and
    `_save_export` charges at the end; either way an absolute write computed
    from a snapshot would clobber a bump that happened after the snapshot. The
    principal is skipped and reported, and tomorrow's run heals it.
    """
    from apps.jobs.models import Job

    from .principals import owned_by

    return owned_by(
        Job.objects.filter(status__in=[Job.Status.QUEUED, Job.Status.RUNNING]),
        principal,
    ).exists()


def _reconcile_one(principal, *, dry_run: bool) -> dict | None:
    """Heal one principal's counter. Returns a drift record, or None.

    The expensive half — listing two storage prefixes — happens *outside* the
    lock, because holding a row lock across S3 round trips would serialize the
    whole sweep behind the slowest bucket. What makes that safe is the
    re-check inside the lock: if the counter moved while we were counting, or a
    job started, the computed total describes a world that no longer exists and
    the write is abandoned rather than applied.
    """
    from django.db import connection, transaction

    model = type(principal)
    before = int(principal.storage_bytes_used)

    if _has_work_in_flight(principal):
        return {"kind": _kind_of(principal), "id": str(principal.pk),
                "skipped": "job in flight"}

    actual = charged_bytes(principal)

    with transaction.atomic():
        if connection.features.has_select_for_update:
            locked = model.objects.select_for_update().filter(pk=principal.pk).first()
        else:
            locked = model.objects.filter(pk=principal.pk).first()
        if locked is None:
            # Deleted while we counted — an expiring guest, an account closing.
            return None
        current = int(locked.storage_bytes_used)
        if current != before:
            return {"kind": _kind_of(principal), "id": str(principal.pk),
                    "skipped": "counter moved while counting"}
        if _has_work_in_flight(principal):
            return {"kind": _kind_of(principal), "id": str(principal.pk),
                    "skipped": "job started while counting"}
        if current == actual:
            return None
        if not dry_run:
            # Absolute, never `F()`: the whole point is to replace a number
            # that has drifted, and a relative update would carry the drift.
            model.objects.filter(pk=principal.pk).update(storage_bytes_used=actual)

    return {"kind": _kind_of(principal), "id": str(principal.pk),
            "before": before, "after": actual, "drift": actual - before}


def _kind_of(principal) -> str:
    from .principals import label

    return label(principal)


@shared_task(name="apps.core.tasks.usage_recompute")
def usage_recompute(principal: str = "", dry_run: bool = False) -> dict:
    """Recompute `storage_bytes_used` from what is actually charged (§15).

    §15 named this task from the beginning and PROGRESS's Redis-throttle
    decision leaned on it ("`usage_recompute` runs daily") — and until
    2026-08-23 there was no such task and no beat entry. It matters more than it
    did when it was first written down: the counter it reconciles is the one
    `enforce_storage` now *refuses* on, so drift is no longer cosmetic. Drift
    upward locks a user out of their own quota; drift downward hands out storage
    nobody is paying for.

    Where drift comes from: `bump_storage` is a bare `F()` UPDATE with no floor
    and no transaction around the blob write it accompanies. A worker killed
    between `put_bytes` and `bump_storage` under-counts; one killed between
    `bump_storage` and the row write over-counts; `exports_purge` refunds and
    strips the key in two steps. None of those is worth a distributed
    transaction. All of them are worth a nightly reconciliation.

    `principal` is an optional UUID — a `User` or a `GuestSession`, tried in
    that order. Expired guest sessions are skipped: `guest_purge` hard-deletes
    them within the hour and healing a counter that is about to be deleted is
    work for nobody.
    """
    from django.contrib.auth import get_user_model

    from .models import GuestSession

    stats: dict = {"checked": 0, "healed": 0, "skipped": 0, "drift_bytes": 0,
                   "dry_run": bool(dry_run), "drifts": []}

    if principal:
        subjects = _one_principal(principal)
        if not subjects:
            logger.warning("usage_recompute: no principal with id %s", principal)
            return stats
    else:
        subjects = list(get_user_model().objects.all().iterator())
        subjects += list(
            GuestSession.objects.filter(expires_at__gt=timezone.now()).iterator()
        )

    for subject in subjects:
        stats["checked"] += 1
        record = _reconcile_one(subject, dry_run=bool(dry_run))
        if record is None:
            continue
        if record.get("skipped"):
            stats["skipped"] += 1
            logger.info("usage_recompute: skipped %(kind)s %(id)s — %(skipped)s",
                        record)
            stats["drifts"].append(record)
            continue
        stats["healed"] += 1
        stats["drift_bytes"] += record["drift"]
        stats["drifts"].append(record)
        if abs(record["drift"]) >= DRIFT_LOG_FLOOR_BYTES:
            logger.warning(
                "usage_recompute: %s %s drifted %+d bytes (%d → %d)%s",
                record["kind"], record["id"], record["drift"],
                record["before"], record["after"],
                " [dry run — not written]" if dry_run else "",
            )

    if stats["healed"] or stats["skipped"]:
        logger.info(
            "usage_recompute: checked %(checked)s, healed %(healed)s, "
            "skipped %(skipped)s, net %(drift_bytes)s bytes", stats)
    return stats


def _one_principal(pk: str) -> list:
    """A `User` or a `GuestSession` by id — the two are both UUIDs, so try
    the account first and fall through."""
    from django.contrib.auth import get_user_model

    from .models import GuestSession

    for model in (get_user_model(), GuestSession):
        try:
            found = model.objects.filter(pk=pk).first()
        except (ValueError, ValidationError):
            continue
        if found is not None:
            return [found]
    return []


# --------------------------------------------------------------------------- #
# Account-side asset hygiene (§15)
# --------------------------------------------------------------------------- #
@shared_task(name="apps.core.tasks.account_assets_purge")
def account_assets_purge(days: int | None = None) -> dict:
    """Sweep an account's stale `uploads/u/{id}/` blobs (§13, §15).

    `purge_principal_assets` runs for guest purge and account deletion only, so
    a guest's stamps die with the session within the hour and an **account's**
    were never swept at all. §13 calls this namespace ephemeral and means it:
    stamps, image watermarks and conversion sources are re-uploaded per session
    by design, and a conversion source is discarded the moment its job finishes.
    What was actually happening is that every one of them was charged to the
    account for ever, with no UI anywhere that could free them.

    **Saved signatures are exempt, and that is not a detail.** A
    `SavedSignature.storage_key` is an ordinary asset key in this very prefix —
    §13 put it there on purpose so signatures would inherit the quota metering,
    the principal-derived key and the guest purge rather than needing three new
    versions of each. They are the one thing here a user deliberately *kept*, so
    they are excluded by key before anything is deleted. Deleting them would
    silently destroy a stored image of somebody's signature and leave a row
    pointing at nothing.

    Guest prefixes are not touched: `guest_purge` owns those and takes the whole
    prefix at expiry, which is both sooner and more complete.
    """
    from datetime import timedelta

    from django.contrib.auth import get_user_model

    from apps.esign.models import SavedSignature
    from apps.pdf_engine.storage import get_storage

    from . import limits as L
    from .assets import principal_prefix

    window = settings.ASSET_RETENTION_DAYS if days is None else days
    cutoff = timezone.now() - timedelta(days=window)
    storage = get_storage()
    stats = {"users": 0, "blobs": 0, "bytes": 0, "kept": 0}

    for user in get_user_model().objects.all().iterator():
        # Derived, never spelled out: `principal_prefix` is the one place that
        # knows a key's shape, and a hand-built `uploads/u/{pk}/` here is a
        # second copy that a change to §13's layout would leave pointing at
        # nothing — a sweep that silently deletes zero blobs for ever.
        prefix = principal_prefix(user)
        try:
            entries = storage.list_prefix_detailed(prefix)
        except Exception:  # noqa: BLE001
            logger.warning("account_assets_purge: could not list %s", prefix)
            continue
        if not entries:
            continue
        # Read per user rather than once: the set is small, and a query scoped
        # to the user is one the isolation sweep can reason about.
        keep = set(SavedSignature.objects.filter(user=user)
                   .values_list("storage_key", flat=True))
        freed = 0
        removed = 0
        for entry in entries:
            if entry["key"] in keep:
                stats["kept"] += 1
                continue
            modified = entry.get("last_modified")
            if modified is None or modified > cutoff:
                stats["kept"] += 1
                continue
            try:
                storage.delete(entry["key"])
            except Exception:  # noqa: BLE001
                logger.warning("account_assets_purge: could not delete %s",
                               entry["key"])
                continue
            freed += int(entry["size"] or 0)
            removed += 1
        if not removed:
            continue
        # One credit per user, after the deletes that earned it — `bump_storage`
        # has no floor, so refunding per key and failing halfway would leave a
        # counter that owes bytes nothing will ever pay back.
        L.bump_storage(user, -freed)
        stats["users"] += 1
        stats["blobs"] += removed
        stats["bytes"] += freed

    if stats["blobs"]:
        logger.info("account_assets_purge: removed %(blobs)s blob(s) from "
                    "%(users)s account(s), freeing %(bytes)s bytes", stats)
    return stats


def redaction_previews_purge(hours: int = 1) -> int:
    """Blank the matched text kept by redaction previews (phase-07, §17).

    A dry run answers with the text of every match so the user can decide which
    ones to remove — social security numbers, card numbers, whatever they were
    looking for. That answer is stored on the job, and a job outlives the
    document it came from (`Job.document` is `SET_NULL`, so deleting the
    document does not take the preview with it). The review list is worth
    nothing an hour later; the copy of the secrets is worth something to
    whoever reads the database next.

    The rects and the count stay, so the history still records what happened.
    """
    from datetime import timedelta

    from apps.jobs.models import Job

    cutoff = timezone.now() - timedelta(hours=hours)
    cleaned = 0
    stale = Job.objects.filter(
        type="redact", finished_at__lt=cutoff, result__has_key="report",
    )
    for job in stale.iterator():
        report = (job.result or {}).get("report") or {}
        matches = report.get("matches") or []
        if not any(m.get("text") for m in matches):
            continue
        for match in matches:
            match["text"] = ""
        job.result = {**(job.result or {}), "report": {**report, "matches": matches}}
        job.save(update_fields=["result"])
        cleaned += 1
    if cleaned:
        logger.info("redaction_previews_purge: cleared text on %s job(s)", cleaned)
    return cleaned


# --------------------------------------------------------------------------- #
# Worker heartbeat (§10.4)
# --------------------------------------------------------------------------- #
HEARTBEAT_KEY = "zen:worker:heartbeat"
#: One key per lane. A single heartbeat only ever proves that *one* worker is
#: alive — the one whose queue it happened to be routed to — so a dead
#: `heavy` worker would leave health green while OCR piled up untouched.
HEARTBEAT_QUEUES = ("default", "heavy", "render")
#: How stale a heartbeat may be before `/api/health/` calls the workers down.
#: Three missed beats — one late run under load is not an incident.
HEARTBEAT_STALE_SECONDS = 300


@shared_task(name="apps.core.tasks.worker_heartbeat")
def worker_heartbeat(queue: str = "default") -> dict:
    """Beat schedules it, a *worker* runs it, and health reads what it wrote.

    That is the whole point: a liveness check that asks Redis whether Redis is
    up proves nothing about the thing that actually does the work. If beat dies
    the value goes stale; if the workers die the value goes stale; either way
    the deep health check says so instead of reporting a green stack with an
    empty queue.
    """
    import time

    from django.core.cache import cache

    stamp = time.time()
    cache.set(f"{HEARTBEAT_KEY}:{queue}", stamp, HEARTBEAT_STALE_SECONDS * 4)
    return {"at": stamp, "queue": queue}


def heartbeat_ages() -> dict:
    """Seconds since each lane last checked in; `None` where it never has."""
    import time

    from django.core.cache import cache

    now = time.time()
    ages: dict[str, float | None] = {}
    for queue in HEARTBEAT_QUEUES:
        stamp = cache.get(f"{HEARTBEAT_KEY}:{queue}")
        ages[queue] = None if stamp is None else max(0.0, now - float(stamp))
    return ages


def heartbeat_age_seconds() -> float | None:
    """The oldest lane, which is the one that matters: a stack is only as
    healthy as the worker that has stopped answering."""
    ages = [age for age in heartbeat_ages().values() if age is not None]
    if len(ages) != len(HEARTBEAT_QUEUES):
        return None
    return max(ages)


def queue_depths() -> dict:
    """How many messages are waiting on each lane, straight from Redis.

    Celery's own inspection API asks the workers and blocks when they are busy
    — which is exactly when somebody is looking. The broker knows without
    asking anybody: each queue is a Redis list.
    """
    import redis
    from django.conf import settings

    client = redis.from_url(settings.REDIS_URL, socket_connect_timeout=1)
    return {name: int(client.llen(name)) for name in ("default", "heavy", "render")}
