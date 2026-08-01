"""Claim-on-signup (01-architecture.md §21.5).

Documents, jobs *and* usage counters, in one transaction, idempotent, and
all-or-nothing when it would overflow quota.
"""
import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

from apps.core.models import GuestSession, UsageCounter, hash_guest_token

pytestmark = pytest.mark.django_db


def _upload(client, fixture_bytes, name="text.pdf"):
    upload = SimpleUploadedFile(name, fixture_bytes(name), content_type="application/pdf")
    resp = client.post("/api/documents/", {"file": upload}, format="multipart")
    assert resp.status_code == 201, resp.content
    return resp.json()


def _session_of(client):
    return GuestSession.objects.get(token_hash=hash_guest_token(client.token))


def _guest_with_work(guest, fixture_bytes):
    """A guest session holding a document, a finished job and a usage counter."""
    doc = _upload(guest, fixture_bytes)
    guest.post(
        f"/api/documents/{doc['id']}/operations/",
        {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90}},
        format="json",
    )
    session = _session_of(guest)
    UsageCounter.objects.create(
        guest_session=session, period="2026-08", conversions=3, heavy_ops=2
    )
    return session, doc


# --------------------------------------------------------------------------- #
# The happy path — everything moves
# --------------------------------------------------------------------------- #
def test_claim_moves_documents_jobs_and_counters(guest, fixture_bytes, user):
    from apps.core.claim import claim_session
    from apps.documents.models import Document
    from apps.jobs.models import Job

    session, doc = _guest_with_work(guest, fixture_bytes)
    summary = claim_session(session, user)

    assert summary["documents"] == 1
    assert summary["jobs"] == 1

    claimed = Document.objects.get(id=doc["id"])
    assert claimed.owner_id == user.id
    assert claimed.guest_session_id is None
    # The guest TTL is cleared — an owned document does not expire (§21.5).
    assert claimed.expires_at is None

    # Jobs move too: leaving one behind kills the poll on the very file the
    # user just signed up to keep.
    assert Job.objects.filter(guest_session=session).count() == 0
    assert Job.objects.filter(user=user).count() == 1

    # Counters are summed, not discarded — otherwise a monthly quota could be
    # reset by laundering work through a guest session.
    counter = UsageCounter.objects.get(user=user, period="2026-08")
    assert counter.conversions == 3
    assert counter.heavy_ops == 2
    assert UsageCounter.objects.filter(guest_session=session).count() == 0


def test_claim_folds_counters_into_an_existing_user_row(guest, fixture_bytes, user):
    from apps.core.claim import claim_session

    UsageCounter.objects.create(user=user, period="2026-08", conversions=10, heavy_ops=1)
    session, _ = _guest_with_work(guest, fixture_bytes)
    claim_session(session, user)

    counter = UsageCounter.objects.get(user=user, period="2026-08")
    assert counter.conversions == 13  # summed, per §21.5 rule 3
    assert counter.heavy_ops == 3
    assert UsageCounter.objects.filter(user=user, period="2026-08").count() == 1


def test_claim_folds_storage_and_expires_the_session(guest, fixture_bytes, user):
    from apps.core.claim import claim_session

    session, _ = _guest_with_work(guest, fixture_bytes)
    guest_bytes = session.storage_bytes_used
    assert guest_bytes > 0

    summary = claim_session(session, user)
    user.refresh_from_db()
    session.refresh_from_db()

    assert user.storage_bytes_used == guest_bytes
    # The preflight must measure what is actually folded. `_guest_with_work`
    # leaves two version blobs behind one document, so the current-version sum
    # is strictly smaller — checking quota against *that* would let a session
    # with edit history pass preflight and still overflow the account.
    assert summary["bytes"] == guest_bytes > summary["current_version_bytes"]
    assert session.claimed_by_id == user.id
    assert session.claimed_at is not None
    # Expired server-side so guest_purge can never cascade into the user's rows.
    assert session.is_expired


def test_claimed_token_replays_are_410(guest, fixture_bytes, user, anon):
    from apps.core.claim import claim_session

    session, _ = _guest_with_work(guest, fixture_bytes)
    claim_session(session, user)

    resp = anon.get("/api/documents/", HTTP_X_GUEST_TOKEN=guest.token)
    assert resp.status_code == 410
    assert resp.json()["error"]["code"] == "guest_expired"


def test_claim_is_idempotent(guest, fixture_bytes, user):
    from apps.core.claim import claim_session

    session, _ = _guest_with_work(guest, fixture_bytes)
    first = claim_session(session, user)
    second = claim_session(session, user)

    assert first["documents"] == 1
    assert second["already_claimed"] is True
    assert (second["documents"], second["jobs"], second["bytes"]) == (0, 0, 0)
    user.refresh_from_db()
    # Storage folded once, not twice.
    assert user.storage_bytes_used == first["bytes"]


# --------------------------------------------------------------------------- #
# Over-quota: refused whole, itemized
# --------------------------------------------------------------------------- #
def test_over_quota_claim_is_refused_whole_and_itemized(guest, fixture_bytes, user, settings):
    import copy

    from apps.core.claim import claim_session
    from apps.core.exceptions import QuotaExceeded
    from apps.documents.models import Document

    session, doc = _guest_with_work(guest, fixture_bytes)
    tiers = copy.deepcopy(settings.TIERS)
    tiers["free"]["storage_mb"] = 0  # nothing fits
    settings.TIERS = tiers

    with pytest.raises(QuotaExceeded) as exc:
        claim_session(session, user)

    details = exc.value.zen_details
    assert details["would_transfer"]["documents"] == 1
    assert details["overflow_bytes"] > 0
    assert details["items"][0]["id"] == doc["id"]
    assert "title" in details["items"][0]

    # Nothing partially claimed, nothing silently dropped.
    still_guest = Document.objects.get(id=doc["id"])
    assert still_guest.guest_session_id == session.id
    assert still_guest.owner_id is None
    session.refresh_from_db()
    assert session.claimed_at is None


# --------------------------------------------------------------------------- #
# The endpoints
# --------------------------------------------------------------------------- #
def test_register_with_a_guest_token_claims_inline(guest, fixture_bytes, anon):
    from apps.documents.models import Document

    _guest_with_work(guest, fixture_bytes)
    resp = anon.post(
        "/api/users/register/",
        {"email": "new@example.com", "password": "strongpass123", "display_name": "New"},
        format="json",
        HTTP_X_GUEST_TOKEN=guest.token,
    )
    assert resp.status_code == 201, resp.content
    assert resp.json()["claimed"]["documents"] == 1

    from django.contrib.auth import get_user_model

    new_user = get_user_model().objects.get(email="new@example.com")
    assert Document.objects.filter(owner=new_user).count() == 1


def test_login_with_a_guest_token_claims_inline(guest, fixture_bytes, anon, user):
    from apps.documents.models import Document

    _guest_with_work(guest, fixture_bytes)
    resp = anon.post(
        "/api/auth/login/",
        {"email": user.email, "password": "pass12345"},
        format="json",
        HTTP_X_GUEST_TOKEN=guest.token,
    )
    assert resp.status_code == 200, resp.content
    assert resp.json()["claimed"]["documents"] == 1
    assert "access" in resp.json()
    assert Document.objects.filter(owner=user).count() == 1


def test_register_without_a_guest_token_still_works(anon):
    resp = anon.post(
        "/api/users/register/",
        {"email": "plain@example.com", "password": "strongpass123"},
        format="json",
    )
    assert resp.status_code == 201
    assert "claimed" not in resp.json()


def test_login_does_not_fail_when_the_claim_would_overflow(
    guest, fixture_bytes, anon, user, settings
):
    """An over-quota claim must not lock someone out of their own account.

    Nothing is transferred (claim is all-or-nothing) and the client still holds
    the guest token, so the files stay reachable and `POST /api/guest/claim/`
    still reports the hard 429. Recorded in the Decisions log.
    """
    import copy

    _guest_with_work(guest, fixture_bytes)
    tiers = copy.deepcopy(settings.TIERS)
    tiers["free"]["storage_mb"] = 0
    settings.TIERS = tiers

    resp = anon.post(
        "/api/auth/login/",
        {"email": user.email, "password": "pass12345"},
        format="json",
        HTTP_X_GUEST_TOKEN=guest.token,
    )
    assert resp.status_code == 200
    assert "access" in resp.json()
    assert resp.json()["claim_error"]["code"] == "quota_exceeded"
    assert "claimed" not in resp.json()


def test_explicit_claim_endpoint_requires_an_account(guest, fixture_bytes):
    _guest_with_work(guest, fixture_bytes)
    resp = guest.post("/api/guest/claim/", {}, format="json")
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "account_required"


def test_explicit_claim_endpoint_transfers(guest, fixture_bytes, api):
    from apps.documents.models import Document

    _guest_with_work(guest, fixture_bytes)
    resp = api.post("/api/guest/claim/", {}, format="json", HTTP_X_GUEST_TOKEN=guest.token)
    assert resp.status_code == 200, resp.content
    assert resp.json()["claimed"]["documents"] == 1
    assert Document.objects.filter(owner__isnull=False).count() == 1


def test_explicit_claim_endpoint_over_quota_returns_429(guest, fixture_bytes, api, settings):
    import copy

    _guest_with_work(guest, fixture_bytes)
    tiers = copy.deepcopy(settings.TIERS)
    tiers["free"]["storage_mb"] = 0
    settings.TIERS = tiers

    resp = api.post("/api/guest/claim/", {}, format="json", HTTP_X_GUEST_TOKEN=guest.token)
    assert resp.status_code == 429
    body = resp.json()["error"]
    assert body["code"] == "quota_exceeded"
    assert body["details"]["would_transfer"]["documents"] == 1


def test_no_email_is_sent_on_any_guest_path(guest, fixture_bytes, anon):
    """No guest action may trigger outbound mail (§17e)."""
    from django.core import mail

    doc = _upload(guest, fixture_bytes)
    guest.post(
        f"/api/documents/{doc['id']}/operations/",
        {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90}},
        format="json",
    )
    guest.get("/api/documents/")
    anon.post(
        "/api/users/register/",
        {"email": "quiet@example.com", "password": "strongpass123"},
        format="json",
        HTTP_X_GUEST_TOKEN=guest.token,
    )
    assert mail.outbox == []
