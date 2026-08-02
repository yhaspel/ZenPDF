"""Ads config, retention honesty and the abuse controls (phase-09 §Tests).

The retention test is the one worth reading twice: it asserts that the number
the privacy policy shows, the setting the sweeper uses, and the beat schedule
that runs it are the same number. A retention promise nobody checks is the kind
of sentence that quietly stops being true.
"""
from datetime import timedelta

import pytest
from django.conf import settings
from django.core import mail
from django.core.files.uploadedfile import SimpleUploadedFile
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
    assert retention["job_days"] == settings.JOB_RETENTION_DAYS
    assert retention["job_params_days"] == settings.JOB_PARAMS_RETENTION_DAYS

    # …and every one of those numbers has a task that enforces it, on the beat
    # schedule. A promise with no sweeper behind it is just a sentence.
    schedule = settings.CELERY_BEAT_SCHEDULE
    assert schedule["trash-purge"]["task"] == "apps.core.tasks.trash_purge"
    assert schedule["exports-purge"]["task"] == "apps.core.tasks.exports_purge"
    assert schedule["guest-purge"]["task"] == "apps.core.tasks.guest_purge"
    assert schedule["jobs-purge"]["task"] == "apps.core.tasks.jobs_purge"
    assert (schedule["job-params-purge"]["task"]
            == "apps.core.tasks.job_params_purge")


def test_a_job_row_outlives_its_export_and_not_the_other_way_round(settings):
    """Ordering, pinned: `exports_purge` finds artefacts by iterating Job rows,
    so if the row went first the blob would be unreachable for ever — the trap
    `guest_purge` and account deletion have each already had to write down."""
    assert settings.JOB_RETENTION_DAYS * 24 > settings.EXPORT_TTL_HOURS


def test_trash_purge_removes_what_the_policy_says_it_removes(api, uploaded_doc,
                                                             settings):
    from apps.core.tasks import trash_purge
    from apps.documents.models import Document

    api.delete(f"/api/documents/{uploaded_doc['id']}/")  # to trash
    assert trash_purge() == {"purged": 0, "kept": 0, "failed": 0}, \
        "purged something fresh"

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
    resp = anon.post(f"/api/mail/unsubscribe/{token}/", format="json")
    assert resp.status_code == 200
    # No address in the answer, because there is none in the token.
    assert resp.json() == {"unsubscribed": True}

    mail.outbox.clear()
    assert core_mail.send("Again", "Body", ["gone@example.com"]) == 0
    assert mail.outbox == []

    # …and it can be undone. The link is printed in every footer and travels
    # with a forwarded message, so a suppression somebody else triggered must
    # not be permanent.
    assert anon.delete(f"/api/mail/unsubscribe/{token}/").status_code == 200
    assert core_mail.send("Again", "Body", ["gone@example.com"]) == 1


def test_the_unsubscribe_link_carries_no_email_address():
    """A URL with somebody's address in it lands in browser history, proxy
    logs and `Referer` headers — the reason `verification.py` signs an id."""
    from apps.core import mail as core_mail

    url = core_mail.unsubscribe_url("visible@example.com")
    assert "visible" not in url and "example.com" not in url
    assert url.startswith(settings.API_BASE_URL + "/api/mail/unsubscribe/")


def test_one_click_unsubscribe_is_answered_by_the_api_not_the_spa(anon):
    """RFC 8058 is a server-to-server POST with no JavaScript in sight.

    Pointed at an Angular route it would return the app shell, suppress
    nothing, and tell the person they had unsubscribed when they had not.
    """
    from apps.core import mail as core_mail

    core_mail.send("Hello", "Body", ["click@example.com"])
    header = mail.outbox[0].extra_headers["List-Unsubscribe"].strip("<>")
    assert header.startswith(settings.API_BASE_URL + "/api/mail/unsubscribe/")

    path = header[len(settings.API_BASE_URL):]
    resp = anon.post(path, {"List-Unsubscribe": "One-Click"},
                     content_type="application/x-www-form-urlencoded")
    assert resp.status_code == 200
    assert core_mail.is_suppressed("click@example.com")


def test_a_browser_following_the_footer_link_is_asked_first(anon):
    """A GET must not suppress: the link is forwarded with the message, and a
    kill switch that fires on load is one anybody downstream can pull."""
    from apps.core import mail as core_mail

    token = core_mail.unsubscribe_token("asked@example.com")
    resp = anon.get(f"/api/mail/unsubscribe/{token}/")
    assert resp.status_code == 302
    assert resp["Location"].endswith(f"/unsubscribe/{token}")
    assert not core_mail.is_suppressed("asked@example.com")


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
    resp = anon.post("/api/mail/unsubscribe/not-a-token/", format="json")
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


def test_ads_txt_is_rendered_from_the_publisher_id(anon, settings):
    """Served from config, not baked into the frontend image — the only thing
    in the file is the publisher id, and that lives in the environment."""
    settings.ADS_PROVIDER = "adsense"
    settings.ADSENSE_CLIENT_ID = ""
    body = anon.get("/api/ads.txt").content.decode()
    assert "google.com," not in body, "no seller is authorised yet"

    settings.ADSENSE_CLIENT_ID = "ca-pub-1234567890123456"
    body = anon.get("/api/ads.txt").content.decode()
    assert "google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0" in body


def test_the_verification_mail_has_a_cooldown(api, user, settings):
    """Registration never proves the address belongs to whoever typed it, so
    an uncapped resend is a mailbomb pointed at a stranger — and this mail is
    transactional, so the suppression list cannot stop it."""
    from django.core.cache import cache

    cache.clear()
    mail.outbox.clear()
    assert api.post("/api/users/verify/send/").status_code == 200
    assert len(mail.outbox) == 1

    second = api.post("/api/users/verify/send/")
    assert second.status_code == 429
    assert len(mail.outbox) == 1


def test_listing_documents_does_not_spend_the_upload_budget(api, fixture_bytes,
                                                            settings):
    """The 20/hour cap is on uploads. DRF runs throttles for every method, so
    without a guard the dashboard would lock a user out of their own library
    in twenty reads."""
    from django.core.cache import cache

    cache.clear()
    for _ in range(25):
        assert api.get("/api/documents/").status_code == 200


def test_public_signing_is_capped_per_token_as_well_as_per_ip(settings):
    """One leaked link must not be replayable all day from a hundred
    addresses — the IP throttle cannot see that pattern (§9B)."""
    from apps.core.throttling import PublicSignTokenThrottle

    assert PublicSignTokenThrottle.scope == "public_sign_token"
    assert settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"][
        "public_sign_token"] == "200/day"


def test_verification_is_capped_per_hour_as_well_as_per_minute(anon,
                                                               fixture_bytes,
                                                               settings):
    """`/api/verify/` decodes an untrusted PDF for an anonymous stranger, so
    a burst limit alone is not a ceiling — 10/min must not mean 600/hour."""
    from django.core.cache import cache

    cache.clear()
    pdf = fixture_bytes("text.pdf")
    settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]["verify"] = "1000/min"
    settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]["verify_hour"] = "2/hour"

    from rest_framework.settings import api_settings

    api_settings.reload()
    try:
        codes = []
        for _ in range(3):
            upload = SimpleUploadedFile("x.pdf", pdf,
                                        content_type="application/pdf")
            codes.append(anon.post("/api/verify/", {"file": upload},
                                   format="multipart").status_code)
        assert codes[-1] == 429
        refused = anon.post(
            "/api/verify/",
            {"file": SimpleUploadedFile("x.pdf", pdf,
                                        content_type="application/pdf")},
            format="multipart",
        )
        assert refused.status_code == 429
        assert refused["Retry-After"]
    finally:
        settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]["verify"] = "10/min"
        settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]["verify_hour"] = "60/hour"
        api_settings.reload()
        cache.clear()


def test_uploading_too_fast_is_refused_with_a_retry_after(api, fixture_bytes,
                                                          settings):
    """The cap that *is* about uploads. 429s carry `Retry-After` (§9B)."""
    from django.core.cache import cache
    from rest_framework.settings import api_settings

    cache.clear()
    pdf = fixture_bytes("text.pdf")
    settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]["upload"] = "2/hour"
    api_settings.reload()
    try:
        codes = []
        for index in range(3):
            upload = SimpleUploadedFile(f"u{index}.pdf", pdf,
                                        content_type="application/pdf")
            codes.append(api.post("/api/documents/", {"file": upload},
                                  format="multipart").status_code)
        assert codes[-1] == 429
        # …and the library is still readable, because reads are not uploads.
        assert api.get("/api/documents/").status_code == 200
    finally:
        settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]["upload"] = "20/hour"
        api_settings.reload()
        cache.clear()
