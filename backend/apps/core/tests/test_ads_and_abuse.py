"""Ads config, retention honesty and the abuse controls (phase-09 §Tests).

The retention test is the one worth reading twice: it asserts that the number
the privacy policy shows, the setting the sweeper uses, and the beat schedule
that runs it are the same number. A retention promise nobody checks is the kind
of sentence that quietly stops being true.
"""
from datetime import timedelta

import pytest
from django.core import mail
from django.utils import timezone

pytestmark = pytest.mark.django_db


# --------------------------------------------------------------------------- #
# 9A — ads are off by default, and off means *nothing*
# --------------------------------------------------------------------------- #
def test_ads_off_ships_no_client_id_no_slots(anon, settings):
    settings.ADS_ENABLED = False
    body = anon.get("/api/config/").json()
    assert body["ads"] == {"enabled": False}
    assert body["features"]["ads_enabled"] is False
    # Nothing to load, and nothing to ask about.
    assert body["consent_required"] is False


def test_ads_on_publishes_the_slots_it_has(anon, settings):
    settings.ADS_ENABLED = True
    settings.ADSENSE_CLIENT_ID = "ca-pub-123"
    settings.ADS_SLOTS = {"dashboard-rail": "111", "tool-result": "", "landing": "333"}

    body = anon.get("/api/config/?region=US").json()["ads"]
    assert body["enabled"] is True
    assert body["client_id"] == "ca-pub-123"
    # An unconfigured slot is absent rather than empty — the component asks for
    # a name, and a name with no unit behind it must render nothing.
    assert body["slots"] == {"dashboard-rail": "111", "landing": "333"}


@pytest.mark.parametrize("region,required", [
    ("DE", True), ("FR", True), ("GB", True), ("NO", True),
    ("US", False), ("BR", False), ("JP", False),
    # No region at all → ask. A browser that reports only "en" is common, and
    # showing a banner nobody needed costs a little revenue, while skipping one
    # somebody did need is a compliance failure. A *stated* region we do not
    # list is taken at its word — the alternative is asking the whole world.
    ("", True),
    ("ZZ", False),
])
def test_consent_is_required_where_it_is_required(anon, settings, region, required):
    settings.ADS_ENABLED = True
    query = f"?region={region}" if region else ""
    assert anon.get(f"/api/config/{query}").json()["consent_required"] is required


# --------------------------------------------------------------------------- #
# 9A — the retention statement is true
# --------------------------------------------------------------------------- #
def test_the_retention_numbers_come_from_the_settings_the_sweepers_use(
        anon, settings):
    """Acceptance criterion: "legal pages … matching real system behavior
    (retention numbers cross-checked against beat config in a test)"."""
    retention = anon.get("/api/config/").json()["retention"]
    assert retention["trash_days"] == settings.TRASH_RETENTION_DAYS
    assert retention["guest_hours"] == settings.GUEST_TTL_HOURS
    assert retention["export_hours"] == settings.EXPORT_TTL_HOURS

    # …and every one of those numbers has a task that enforces it, on the beat
    # schedule. A promise with no sweeper behind it is just a sentence.
    schedule = settings.CELERY_BEAT_SCHEDULE
    assert schedule["trash-purge"]["task"] == "apps.core.tasks.trash_purge"
    assert schedule["exports-purge"]["task"] == "apps.core.tasks.exports_purge"
    assert schedule["guest-purge"]["task"] == "apps.core.tasks.guest_purge"


def test_trash_purge_removes_what_the_policy_says_it_removes(api, uploaded_doc,
                                                             settings):
    from apps.core.tasks import trash_purge
    from apps.documents.models import Document

    api.delete(f"/api/documents/{uploaded_doc['id']}/")  # to trash
    assert trash_purge() == {"purged": 0, "kept": 0}, "purged something fresh"

    Document.objects.filter(id=uploaded_doc["id"]).update(
        trashed_at=timezone.now() - timedelta(days=settings.TRASH_RETENTION_DAYS + 1))
    assert trash_purge()["purged"] == 1
    assert not Document.objects.filter(id=uploaded_doc["id"]).exists()


# --------------------------------------------------------------------------- #
# 9B — mail: suppression, unsubscribe, footer
# --------------------------------------------------------------------------- #
def test_every_message_carries_an_unsubscribe_and_an_abuse_contact(settings):
    from apps.core import mail as core_mail

    core_mail.send("Hello", "Body text.", ["someone@example.com"])
    assert len(mail.outbox) == 1
    message = mail.outbox[0]
    assert settings.ABUSE_CONTACT_EMAIL in message.body
    assert "/unsubscribe/" in message.body
    assert message.extra_headers["List-Unsubscribe"].startswith("<")
    # Without this Gmail shows no one-click button, and the person who wanted
    # out clicks "report spam" instead — which costs the whole domain.
    assert message.extra_headers["List-Unsubscribe-Post"] == "List-Unsubscribe=One-Click"


def test_a_suppressed_address_is_never_mailed_again(anon):
    from apps.core import mail as core_mail

    token = core_mail.unsubscribe_token("gone@example.com")
    resp = anon.post("/api/mail/unsubscribe/", {"token": token}, format="json")
    assert resp.status_code == 200
    assert resp.json() == {"unsubscribed": True, "email": "gone@example.com"}

    mail.outbox.clear()
    assert core_mail.send("Again", "Body", ["gone@example.com"]) == 0
    assert mail.outbox == []


def test_a_transactional_message_still_reaches_a_suppressed_address():
    """Somebody who unsubscribed from signing mail must still be able to
    confirm their own address, or a preference about *another person's*
    document locks them out of their own account."""
    from apps.core import mail as core_mail

    core_mail.suppress("locked@example.com")
    mail.outbox.clear()
    assert core_mail.send("Confirm your email", "Body", ["locked@example.com"],
                          transactional=True, unsubscribable=False) == 1
    assert "unsubscribe" not in mail.outbox[0].body.lower()


def test_a_tampered_unsubscribe_link_is_refused(anon):
    resp = anon.post("/api/mail/unsubscribe/", {"token": "not-a-token"},
                     format="json")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "validation_error"


# --------------------------------------------------------------------------- #
# 9B — email verification gates sending, and *only* sending
# --------------------------------------------------------------------------- #
def test_an_unverified_account_can_still_do_everything_else(api, fixture_bytes):
    """The rule that matters: a guest uploads freely, so a registered account
    must never be worse off. Verification gates sending for signature alone."""
    from django.core.files.uploadedfile import SimpleUploadedFile

    upload = SimpleUploadedFile("text.pdf", fixture_bytes("text.pdf"),
                                content_type="application/pdf")
    resp = api.post("/api/documents/", {"file": upload}, format="multipart")
    assert resp.status_code == 201, "verification blocked an upload"

    doc_id = resp.json()["id"]
    op = api.post(f"/api/documents/{doc_id}/operations/",
                  {"type": "rotate_pages",
                   "params": {"pages": [0], "degrees": 90},
                   "base_version_seq": 1}, format="json")
    assert op.status_code == 202


def test_verification_is_a_link_in_a_mail_and_one_post(api, user, anon):
    mail.outbox.clear()
    assert api.post("/api/users/verify/send/", format="json").json() == {
        "verified": False, "sent": True,
    }
    assert len(mail.outbox) == 1
    body = mail.outbox[0].body
    assert "/verify-email/" in body

    token = body.split("/verify-email/")[1].split()[0]
    # The address itself is not in the link: a URL carrying an email ends up in
    # history, logs and referrers.
    assert user.email not in body.split("/verify-email/")[1]
    # Answered by *anyone* holding the token: the link opens in a mail client
    # that may not be the signed-in browser.
    resp = anon.post("/api/users/verify/", {"token": token}, format="json")
    assert resp.status_code == 200 and resp.json()["verified"] is True

    user.refresh_from_db()
    assert user.email_verified is True


def test_an_expired_or_forged_verification_link_says_so(anon):
    resp = anon.post("/api/users/verify/", {"token": "nope"}, format="json")
    assert resp.status_code == 400
    assert "not valid" in resp.json()["error"]["message"]
