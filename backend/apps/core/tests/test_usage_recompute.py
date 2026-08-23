"""`usage_recompute` — the reconciler §15 named and nobody wrote (queue, 2026-08-02).

The counter under test is not cosmetic any more. `enforce_storage` *refuses* on
`storage_bytes_used`, so drift upward locks a user out of quota they are not
using and drift downward gives away the one resource the product meters. What
this file has to establish is not that the task runs, but that it agrees with
every other task that moves the same number — claim, both purges, and the export
GC — because a reconciler that disagrees with them is itself the drift.
"""
import uuid
from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone

from apps.core import limits as L
from apps.core.tasks import charged_bytes, usage_recompute
from apps.jobs.models import Job
from apps.pdf_engine.storage import get_storage

pytestmark = pytest.mark.django_db


def _skew(principal, delta: int) -> None:
    """Move the counter without moving anything it counts.

    Re-reads first. `bump_storage` writes with `F()` and never refreshes the
    instance that was handed to it, so a fixture object created before an upload
    still says 0 — the exact trap `storage_used_fresh` exists for. Computing the
    skew from the stale value would silently *erase* the real charge instead of
    offsetting it, and the test would then be asserting about nothing.
    """
    principal.refresh_from_db()
    type(principal).objects.filter(pk=principal.pk).update(
        storage_bytes_used=int(principal.storage_bytes_used) + delta
    )
    principal.refresh_from_db()


def _counter(principal) -> int:
    principal.refresh_from_db()
    return int(principal.storage_bytes_used)


# --------------------------------------------------------------------------- #
# The counter is healed in both directions
# --------------------------------------------------------------------------- #
def test_drift_upward_is_healed(api, uploaded_doc, user):
    """The direction that locks somebody out of their own account."""
    truth = _counter(user)
    _skew(user, 50 * 1024 * 1024)
    assert _counter(user) != truth

    stats = usage_recompute()
    assert stats["healed"] == 1
    assert _counter(user) == truth


def test_drift_downward_is_healed(api, uploaded_doc, user):
    """The direction that gives storage away."""
    truth = _counter(user)
    _skew(user, -(truth // 2) - 1)

    usage_recompute()
    assert _counter(user) == truth


def test_a_counter_that_is_already_right_is_left_alone(api, uploaded_doc, user):
    before = _counter(user)
    stats = usage_recompute()
    assert stats["healed"] == 0
    assert _counter(user) == before


def test_dry_run_reports_without_writing(api, uploaded_doc, user):
    """The management command's default. It must report the same drift it
    would have fixed, and fix nothing."""
    truth = _counter(user)
    _skew(user, 12345)

    stats = usage_recompute(dry_run=True)
    assert stats["healed"] == 1
    assert stats["drift_bytes"] == truth - (truth + 12345)
    assert _counter(user) == truth + 12345, "a dry run must not write"

    usage_recompute()
    assert _counter(user) == truth


# --------------------------------------------------------------------------- #
# What counts, per namespace
# --------------------------------------------------------------------------- #
def test_every_version_counts_not_only_the_current_one(api, uploaded_doc, user):
    """`Document.size_bytes` is the *current* version. The quota is charged per
    version blob, and `claim.preflight` says so in as many words — a reconciler
    that summed documents would refund a user's whole edit history."""
    from apps.documents.models import Document, DocumentVersion

    resp = api.post(f"/api/documents/{uploaded_doc['id']}/operations/",
                    {"type": "rotate_pages",
                     "params": {"pages": [0], "degrees": 90}}, format="json")
    assert resp.status_code == 202, resp.content

    document = Document.objects.get(pk=uploaded_doc["id"])
    versions = DocumentVersion.objects.filter(document=document)
    assert versions.count() >= 2, "this test needs a second version to be about anything"

    total = sum(v.size_bytes for v in versions)
    assert charged_bytes(user) >= total
    assert charged_bytes(user) > document.size_bytes


def test_a_trashed_document_still_counts(api, uploaded_doc, user):
    """Trash costs until it is purged — `_purge` is the only thing that credits
    the bytes back, and `trash_purge` does not call it for thirty days. A
    reconciler that skipped trashed documents would hand out free storage on
    the day somebody pressed Trash."""
    truth = _counter(user)

    assert api.delete(f"/api/documents/{uploaded_doc['id']}/").status_code == 204
    assert charged_bytes(user) == truth

    usage_recompute()
    assert _counter(user) == truth


def test_the_purge_and_the_reconciler_agree(api, uploaded_doc, user):
    """Permanent deletion refunds; the reconciler must arrive at the same
    number rather than re-charging what was just credited."""
    assert api.delete(f"/api/documents/{uploaded_doc['id']}/").status_code == 204
    resp = api.delete(f"/api/documents/{uploaded_doc['id']}/?permanent=true")
    assert resp.status_code == 204, resp.content

    after_purge = _counter(user)
    usage_recompute()
    assert _counter(user) == after_purge


def test_uploaded_assets_count(api, user, fixture_bytes):
    """`uploads/{u}/{id}/` blobs have no rows — the ref is opaque and nothing
    records a size — so the prefix is the only source of truth for them."""
    from apps.core.assets import store_image

    before = charged_bytes(user)
    # Through the real path, so the blob is normalized and keyed the way the API
    # keys it; a hand-written key would not prove the prefix is what gets read.
    assert store_image(user, _tiny_png())["ref"]

    assert charged_bytes(user) > before
    assert _counter(user) == charged_bytes(user)


def _tiny_png() -> bytes:
    """A 4×4 PNG, built rather than shipped, so this file has no binary fixture."""
    import zlib

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (len(payload).to_bytes(4, "big") + kind + payload
                + zlib.crc32(kind + payload).to_bytes(4, "big"))

    raw = b"".join(b"\x00" + b"\xff\x00\x00" * 4 for _ in range(4))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", (4).to_bytes(4, "big") + (4).to_bytes(4, "big")
                    + bytes([8, 2, 0, 0, 0]))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


def test_a_live_export_counts_and_a_swept_one_does_not(api, uploaded_doc, user):
    """Presence is read from storage, not from the row's `storage_key`.

    `exports_purge` refunds and *then* strips the key, in two steps with no
    transaction; a worker killed between them leaves a row advertising a key
    whose blob is gone and already credited. Counting the key would re-charge
    it for ever — which is the shape `jobs_purge` already had to write down.
    """
    resp = api.post(f"/api/documents/{uploaded_doc['id']}/operations/",
                    {"type": "convert_to", "params": {"format": "txt"},
                     "base_version_seq": 1}, format="json")
    assert resp.status_code == 202, resp.content
    job = Job.objects.get(id=resp.json()["id"])
    size = int(job.result["export"]["size_bytes"])
    assert size > 0

    with_export = charged_bytes(user)

    # Delete the blob but leave the row exactly as it is — the killed-worker
    # state, staged.
    get_storage().delete_prefix(f"exports/{job.id}/")
    job.refresh_from_db()
    assert (job.result or {}).get("export", {}).get("storage_key"), \
        "the row must still advertise the key for this test to be about anything"

    assert charged_bytes(user) == with_export - size


# --------------------------------------------------------------------------- #
# What it refuses to touch
# --------------------------------------------------------------------------- #
def test_a_principal_with_a_running_job_is_skipped_and_reported(api, uploaded_doc,
                                                                user):
    """The counter is mid-flight: `_save_new_version` charges before the row is
    visible here, so an absolute write computed from a snapshot would clobber
    the bump. Skipped, reported, and healed by tomorrow's run."""
    truth = _counter(user)
    _skew(user, 999_999)
    Job.objects.create(user=user, type="ocr", status=Job.Status.RUNNING)

    stats = usage_recompute()
    assert stats["skipped"] == 1
    assert stats["healed"] == 0
    assert _counter(user) == truth + 999_999, "the drift must survive the skip"
    assert any("job in flight" in (d.get("skipped") or "") for d in stats["drifts"])


def test_an_expired_guest_session_is_not_walked(guest, guest_doc, user):
    """`guest_purge` hard-deletes it within the hour. Healing a counter that is
    about to be deleted is work for nobody, and walking storage for it is a
    listing per expiring session per night."""
    from apps.core.models import GuestSession

    session = GuestSession.objects.get()
    GuestSession.objects.filter(pk=session.pk).update(
        expires_at=timezone.now() - timedelta(hours=1))
    _skew(session, 4096)

    stats = usage_recompute()
    ids = {d["id"] for d in stats["drifts"]}
    assert str(session.pk) not in ids
    assert _counter(session) != charged_bytes(session)


def test_a_live_guest_session_is_healed(guest, guest_doc):
    """Guests are principals too — and the guest quota is the one a stranger
    hits first."""
    from apps.core.models import GuestSession

    session = GuestSession.objects.get()
    truth = _counter(session)
    _skew(session, -truth)

    usage_recompute()
    assert _counter(session) == truth


# --------------------------------------------------------------------------- #
# Isolation — it walks every principal, so it must never cross one
# --------------------------------------------------------------------------- #
def test_one_principal_is_never_charged_for_another(api, other_api, uploaded_doc,
                                                    fixture_bytes, user, other_user):
    upload = SimpleUploadedFile("text.pdf", fixture_bytes("text.pdf"),
                                content_type="application/pdf")
    assert other_api.post("/api/documents/", {"file": upload},
                          format="multipart").status_code == 201

    alice, bob = charged_bytes(user), charged_bytes(other_user)
    assert alice > 0 and bob > 0

    usage_recompute()
    assert _counter(user) == alice
    assert _counter(other_user) == bob
    assert _counter(user) != _counter(user) + bob


def test_targeting_one_principal_leaves_the_others_alone(api, other_api,
                                                         uploaded_doc,
                                                         fixture_bytes,
                                                         user, other_user):
    upload = SimpleUploadedFile("text.pdf", fixture_bytes("text.pdf"),
                                content_type="application/pdf")
    other_api.post("/api/documents/", {"file": upload}, format="multipart")

    _skew(user, 111)
    _skew(other_user, 222)
    bobs_drifted_counter = _counter(other_user)

    stats = usage_recompute(principal=str(user.pk))
    assert stats["checked"] == 1
    assert _counter(other_user) == bobs_drifted_counter


def test_an_unknown_principal_id_changes_nothing(api, uploaded_doc, user):
    _skew(user, 777)
    stats = usage_recompute(principal=str(uuid.uuid4()))
    assert stats["checked"] == 0
    assert _counter(user) == charged_bytes(user) + 777


def test_a_malformed_principal_id_does_not_raise(api, uploaded_doc):
    assert usage_recompute(principal="not-a-uuid")["checked"] == 0


# --------------------------------------------------------------------------- #
# Claim — the two must agree about what moved
# --------------------------------------------------------------------------- #
def test_claim_then_recompute_agrees_with_the_claim(guest, guest_doc, fixture_bytes):
    """`claim_session` folds the session's counter into the user's. If the
    reconciler then arrived at a different number, one of the two would be
    wrong on the single most valuable moment in the funnel (§21.5)."""
    from apps.core.claim import claim_session
    from apps.core.models import GuestSession

    session = GuestSession.objects.get()
    claimer = get_user_model().objects.create_user(
        email="claimer@example.com", password="pass12345")

    claim_session(session, claimer)
    claimer.refresh_from_db()
    after_claim = int(claimer.storage_bytes_used)
    assert after_claim > 0

    assert charged_bytes(claimer) == after_claim
    usage_recompute()
    assert _counter(claimer) == after_claim


def test_guest_purge_then_recompute_agrees(guest, guest_doc, user):
    """After the session and its documents are gone, nothing is charged to
    anybody for them — including to the account that never owned them."""
    from apps.core.models import GuestSession
    from apps.core.tasks import guest_purge

    GuestSession.objects.update(expires_at=timezone.now() - timedelta(hours=1))
    assert guest_purge()["sessions"] == 1

    stats = usage_recompute()
    assert stats["checked"] >= 1
    assert _counter(user) == charged_bytes(user)


# --------------------------------------------------------------------------- #
# The command
# --------------------------------------------------------------------------- #
def test_the_command_reports_and_does_not_write_by_default(api, uploaded_doc, user):
    """A wrong recompute is a wrong quota for every user, so the human-facing
    entry point defaults to reporting."""
    from io import StringIO

    from django.core.management import call_command

    truth = _counter(user)
    _skew(user, 8_388_608)

    out = StringIO()
    call_command("recompute_usage", stdout=out)
    printed = out.getvalue()

    assert "would be corrected" in printed
    assert "--apply" in printed
    assert _counter(user) == truth + 8_388_608


def test_the_command_writes_with_apply(api, uploaded_doc, user):
    from io import StringIO

    from django.core.management import call_command

    truth = _counter(user)
    _skew(user, 8_388_608)

    out = StringIO()
    call_command("recompute_usage", "--apply", stdout=out)
    assert "corrected" in out.getvalue()
    assert _counter(user) == truth


def test_the_command_refuses_a_contradiction(api, uploaded_doc):
    from django.core.management import call_command
    from django.core.management.base import CommandError

    with pytest.raises(CommandError):
        call_command("recompute_usage", "--apply", "--dry-run")


def test_the_quota_check_reads_the_healed_number(api, uploaded_doc, user, settings):
    """The point of the whole task: `enforce_storage` refuses on this counter,
    so a healed counter has to change what the door does."""
    import copy

    from apps.core.exceptions import QuotaExceeded

    tiers = copy.deepcopy(settings.TIERS)
    tiers["free"]["storage_mb"] = 1
    settings.TIERS = tiers

    _skew(user, 4 * 1024 * 1024)
    with pytest.raises(QuotaExceeded):
        L.enforce_storage(user, 1024)

    usage_recompute()
    L.enforce_storage(user, 1024)  # does not raise
