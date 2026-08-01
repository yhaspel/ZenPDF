"""Tier-resolved limits and metering (01-architecture.md §16)."""
import copy

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

from apps.core import limits as L

pytestmark = pytest.mark.django_db


def _upload(client, data, name="text.pdf"):
    upload = SimpleUploadedFile(name, data, content_type="application/pdf")
    return client.post("/api/documents/", {"file": upload}, format="multipart")


# --------------------------------------------------------------------------- #
# METERED_OPS is not the heavy queue — trap 2
# --------------------------------------------------------------------------- #
def test_metered_ops_is_exactly_the_documented_set():
    assert L.METERED_OPS == {"ocr", "convert_from", "convert_to", "compare"}


def test_metered_ops_is_disjoint_from_the_flagship_tool_pages():
    """⚠ The `heavy` queue also holds merge, alternate_mix, compress and repair.

    Deriving the guest rate cap or the Turnstile challenge from `op.queue` would
    put a CAPTCHA in front of a guest's first merge — the exact outcome §21.1
    exists to prevent. Queue membership is worker sizing; METERED_OPS is cost
    control. They must stay different sets.
    """
    flagship = {"merge", "alternate_mix", "compress", "repair"}
    assert L.METERED_OPS.isdisjoint(flagship)
    for op_type in flagship:
        assert not L.is_metered(op_type)


def test_heavy_queue_membership_is_not_used_as_the_metering_signal():
    from apps.pdf_engine import registry

    heavy = {name for name, op in registry.OPERATIONS.items() if op.queue == "heavy"}
    # The registry's heavy queue and METERED_OPS genuinely differ today; if they
    # ever coincide, the distinction has silently collapsed.
    assert heavy - L.METERED_OPS, "heavy queue must contain non-metered ops"


def test_metered_ops_never_charge_a_cheap_op(guest_session):
    session, _ = guest_session
    for op_type in ("merge", "compress", "rotate_pages", "split"):
        L.enforce_metered_op(session, op_type)
    assert L.metered_ops_used_this_hour(session) == 0


# --------------------------------------------------------------------------- #
# Tier resolution
# --------------------------------------------------------------------------- #
def test_tier_selection(user, guest_session):
    session, _ = guest_session
    assert L.for_principal(session).tier == "guest"
    assert L.for_principal(user).tier == "free"
    user.plan = "pro"
    assert L.for_principal(user).tier == "pro"
    # An unknown plan falls back to free rather than crashing a quota check.
    user.plan = "enterprise"
    assert L.for_principal(user).tier == "free"
    # No principal is quoted guest limits — what it gets on its first write.
    assert L.for_principal(None).tier == "guest"


def test_tier_values_match_the_architecture_table(settings):
    guest = L.for_tier("guest")
    free = L.for_tier("free")
    pro = L.for_tier("pro")
    assert guest.storage_bytes == 200 * 1024 * 1024
    assert guest.max_upload_bytes == 25 * 1024 * 1024
    assert guest.max_pages == 300
    assert guest.max_concurrent_jobs == 1
    assert guest.metered_ops_per_hour == 5
    assert guest.version_retention == 10
    assert guest.library is False
    assert (free.max_pages, free.max_concurrent_jobs, free.metered_ops_per_hour) == (2000, 3, 40)
    assert (pro.max_pages, pro.max_concurrent_jobs, pro.metered_ops_per_hour) == (5000, 6, 200)
    assert pro.ads is False


def test_pro_is_config_only_with_no_purchase_path():
    """§21.7: no billing, no checkout, no upgrade UI in v1.

    `plan` is settable through Django admin alone — nothing user-facing may
    write it.
    """
    from apps.users.serializers import UserSerializer

    assert "plan" not in UserSerializer.Meta.fields


# --------------------------------------------------------------------------- #
# Boundaries, enforced
# --------------------------------------------------------------------------- #
def test_guest_upload_over_25mb_is_413(guest, fixture_bytes):
    payload = fixture_bytes("text.pdf") + b"\n%padding" * (26 * 1024 * 1024 // 9)
    resp = _upload(guest, payload)
    assert resp.status_code == 413
    body = resp.json()["error"]
    assert body["code"] == "file_too_large"
    assert body["details"]["tier"] == "guest"
    # Copy must name the upgrade (acceptance criterion 5).
    assert "account" in body["message"].lower()


def test_guest_storage_quota_at_the_exact_boundary(guest, guest_doc, settings):
    from apps.core.models import GuestSession

    session = GuestSession.objects.get()
    tiers = copy.deepcopy(settings.TIERS)
    tiers["guest"]["storage_mb"] = 1
    settings.TIERS = tiers
    GuestSession.objects.filter(pk=session.pk).update(
        storage_bytes_used=1 * 1024 * 1024 - 10
    )
    resp = _upload(guest, b"%PDF-1.4 tiny")
    assert resp.status_code in (415, 429)  # rejected either way; never accepted


def test_max_pages_is_enforced_at_ingest_for_guests(guest, fixture_bytes, settings):
    """`MAX_PAGES` was never checked anywhere before this phase (§17)."""
    tiers = copy.deepcopy(settings.TIERS)
    tiers["guest"]["max_pages"] = 2
    settings.TIERS = tiers
    resp = _upload(guest, fixture_bytes("text.pdf"))  # 3 pages
    assert resp.status_code == 400
    body = resp.json()["error"]
    assert body["code"] == "validation_error"
    assert body["details"] == {"pages": 3, "max_pages": 2, "tier": "guest"}
    assert "account" in body["message"].lower()


def test_max_pages_is_enforced_at_ingest_for_accounts(api, fixture_bytes, settings):
    tiers = copy.deepcopy(settings.TIERS)
    tiers["free"]["max_pages"] = 2
    settings.TIERS = tiers
    resp = _upload(api, fixture_bytes("text.pdf"))
    assert resp.status_code == 400
    assert resp.json()["error"]["details"]["max_pages"] == 2


def test_max_pages_boundary_accepts_exactly_the_limit(guest, fixture_bytes, settings):
    tiers = copy.deepcopy(settings.TIERS)
    tiers["guest"]["max_pages"] = 3
    settings.TIERS = tiers
    assert _upload(guest, fixture_bytes("text.pdf")).status_code == 201


def test_guest_concurrency_limit_is_one(guest, guest_doc, settings):
    """Tier-resolved concurrency: 1 guest / 3 free / 6 pro (§16).

    Was a single global `MAX_CONCURRENT_JOBS` before 2B.
    """
    from apps.core.models import GuestSession
    from apps.jobs.models import Job

    Job.objects.create(
        guest_session=GuestSession.objects.get(), type="noop_sleep",
        status=Job.Status.RUNNING,
    )
    resp = guest.post(
        f"/api/documents/{guest_doc['id']}/operations/",
        {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90}},
        format="json",
    )
    assert resp.status_code == 429
    body = resp.json()["error"]
    assert body["code"] == "quota_exceeded"
    assert body["details"] == {"limit": 1, "tier": "guest"}
    assert "account" in body["message"].lower()


def test_account_concurrency_limit_is_three(api, uploaded_doc, user):
    from apps.jobs.models import Job

    for _ in range(3):
        Job.objects.create(user=user, type="noop_sleep", status=Job.Status.RUNNING)
    resp = api.post(
        f"/api/documents/{uploaded_doc['id']}/operations/",
        {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90}},
        format="json",
    )
    assert resp.status_code == 429
    assert resp.json()["error"]["details"]["limit"] == 3


def test_concurrency_counts_only_the_callers_own_jobs(guest, guest_doc, user):
    """A busy account must not consume a guest's single slot."""
    from apps.jobs.models import Job

    for _ in range(5):
        Job.objects.create(user=user, type="noop_sleep", status=Job.Status.RUNNING)
    resp = guest.post(
        f"/api/documents/{guest_doc['id']}/operations/",
        {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90}},
        format="json",
    )
    assert resp.status_code == 202


# --------------------------------------------------------------------------- #
# Hourly metered window (Redis counters, not UsageCounter rows — §16)
# --------------------------------------------------------------------------- #
def test_metered_hourly_cap_for_a_guest(guest_session):
    from apps.core.exceptions import QuotaExceeded

    session, _ = guest_session
    for _ in range(5):  # guest cap
        L.enforce_metered_op(session, "ocr")
    assert L.metered_ops_used_this_hour(session) == 5

    with pytest.raises(QuotaExceeded) as exc:
        L.enforce_metered_op(session, "ocr")
    assert exc.value.zen_details == {
        "limit": 5, "used": 5, "window": "hour", "tier": "guest"
    }
    assert "account" in str(exc.value.detail).lower()


def test_metered_cap_is_higher_for_an_account(user):
    for _ in range(6):  # would already have failed as a guest
        L.enforce_metered_op(user, "ocr")
    assert L.metered_ops_used_this_hour(user) == 6


def test_metered_window_is_per_principal(guest_session, user):
    session, _ = guest_session
    L.enforce_metered_op(session, "ocr")
    assert L.metered_ops_used_this_hour(session) == 1
    assert L.metered_ops_used_this_hour(user) == 0


def test_monthly_heavy_ops_row_is_written_alongside_the_redis_window(user):
    from apps.core.models import UsageCounter

    L.enforce_metered_op(user, "convert_to")
    counter = UsageCounter.objects.get(user=user)
    assert counter.heavy_ops == 1
    # Month granularity only — the hourly window is never a row (§16).
    assert len(counter.period) == 7
