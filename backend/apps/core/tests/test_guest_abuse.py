"""Abuse controls for anonymous access (01-architecture.md §17).

Removing the login wall removes the cheapest abuse filter, so it is replaced
deliberately rather than dropped.
"""
import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

from apps.core.models import GuestSession

pytestmark = pytest.mark.django_db


def _upload(client, fixture_bytes, **extra):
    upload = SimpleUploadedFile(
        "text.pdf", fixture_bytes("text.pdf"), content_type="application/pdf"
    )
    return client.post("/api/documents/", {"file": upload}, format="multipart", **extra)


# --------------------------------------------------------------------------- #
# Throttle keying: (guest_token, ip_hash), stricter wins (§16, §17b)
# --------------------------------------------------------------------------- #
def test_throttle_key_falls_back_to_ip_when_the_token_rotates(anon, settings, monkeypatch):
    """Clearing localStorage must not be a free quota reset.

    A fresh token each time defeats the token bucket entirely — the IP leg is
    what still catches it, which is why both throttles run and the stricter of
    the two wins.
    """
    from apps.core.throttling import GuestIPThrottle, GuestThrottle

    rates = {**settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"], "guest": "3/min"}
    # monkeypatch, not plain assignment: THROTTLE_RATES is a class attribute, so
    # a raw `cls.THROTTLE_RATES = …` would leave every later test in the session
    # running at 3/min.
    for cls in (GuestThrottle, GuestIPThrottle):
        monkeypatch.setattr(cls, "THROTTLE_RATES", rates, raising=False)

    statuses = []
    for _ in range(6):
        # A brand-new session every call: the token bucket never accumulates.
        _session, raw = GuestSession.mint(ip="198.51.100.44")
        resp = anon.get(
            "/api/documents/", HTTP_X_GUEST_TOKEN=raw, REMOTE_ADDR="198.51.100.44"
        )
        statuses.append(resp.status_code)

    assert 429 in statuses, f"rotating the token bypassed the throttle: {statuses}"


def test_guest_throttles_do_not_apply_to_accounts(api, settings):
    from apps.core.throttling import GuestIPThrottle, GuestThrottle

    request = type("R", (), {"guest_session": None})()
    assert GuestThrottle().allow_request(request, None) is True
    assert GuestIPThrottle().allow_request(request, None) is True


def test_ip_hash_is_never_surfaced_in_a_user_facing_payload(guest, guest_doc):
    """`ip_hash` exists for abuse correlation only — not analytics, and never in
    a user-facing or ad-facing payload (§17)."""
    session = GuestSession.objects.get()
    assert session.ip_hash
    for path in ("/api/config/", "/api/users/me/usage/", "/api/documents/"):
        assert session.ip_hash not in guest.get(path).content.decode()
    assert session.ip_hash not in guest.post(
        "/api/guest/session/", {}, format="json"
    ).content.decode()


# --------------------------------------------------------------------------- #
# Turnstile — metered ops only, off in dev (§17c)
# --------------------------------------------------------------------------- #
def test_captcha_is_off_by_default(settings, guest_session):
    from apps.core import captcha

    assert settings.CAPTCHA_ENABLED is False
    assert captcha.enabled() is False
    session, _ = guest_session
    captcha.enforce(_FakeRequest(), session, "ocr")  # no raise


def test_captcha_never_challenges_a_cheap_op(settings, guest_session, monkeypatch):
    """A CAPTCHA in front of a guest's first merge defeats the whole phase."""
    from apps.core import captcha

    settings.CAPTCHA_ENABLED = True
    settings.TURNSTILE_SECRET_KEY = "secret"
    monkeypatch.setattr(captcha, "verify_token", lambda *a, **k: False)
    session, _ = guest_session
    for op_type in ("merge", "compress", "split", "rotate_pages", "alternate_mix", "repair"):
        captcha.enforce(_FakeRequest(), session, op_type)  # must not raise


def test_captcha_challenges_a_metered_op_once_per_session(
    settings, guest_session, monkeypatch
):
    from apps.core import captcha
    from apps.core.exceptions import CaptchaRequired

    settings.CAPTCHA_ENABLED = True
    settings.TURNSTILE_SECRET_KEY = "secret"
    session, _ = guest_session

    monkeypatch.setattr(captcha, "verify_token", lambda *a, **k: False)
    with pytest.raises(CaptchaRequired) as exc:
        captcha.enforce(_FakeRequest(), session, "ocr")
    assert exc.value.default_code == "captcha_required"
    assert exc.value.status_code == 403

    # Solve it once…
    monkeypatch.setattr(captcha, "verify_token", lambda *a, **k: True)
    captcha.enforce(_FakeRequest(token="ok"), session, "ocr")
    session.refresh_from_db()
    assert session.captcha_passed_at is not None

    # …and it is never asked again this session, even if verification would fail.
    monkeypatch.setattr(captcha, "verify_token", lambda *a, **k: False)
    captcha.enforce(_FakeRequest(), session, "ocr")


def test_captcha_never_challenges_an_account(settings, user, monkeypatch):
    from apps.core import captcha

    settings.CAPTCHA_ENABLED = True
    settings.TURNSTILE_SECRET_KEY = "secret"
    monkeypatch.setattr(captcha, "verify_token", lambda *a, **k: False)
    captcha.enforce(_FakeRequest(), user, "ocr")  # no raise


def test_turnstile_verification_rejects_on_network_failure(settings, monkeypatch):
    """Fail closed: an unreachable verifier must not wave traffic through."""
    from apps.core import captcha

    settings.TURNSTILE_SECRET_KEY = "secret"

    class _Boom:
        @staticmethod
        def post(*a, **k):
            raise OSError("network down")

    monkeypatch.setitem(__import__("sys").modules, "requests", _Boom)
    assert captcha.verify_token("anything") is False
    assert captcha.verify_token("") is False


class _FakeRequest:
    def __init__(self, token: str = ""):
        self.META = {"HTTP_X_CAPTCHA_TOKEN": token, "REMOTE_ADDR": "203.0.113.1"}


# --------------------------------------------------------------------------- #
# No anonymous party may choose a recipient address (§17e, §21.3)
# --------------------------------------------------------------------------- #
def test_no_guest_reachable_route_accepts_a_recipient_address():
    """The precise invariant: address *selection*, not message *triggering*.

    Phase 8 legitimately mails fixed addresses on ceremony actions — a signer
    completing notifies the next one, and that address was chosen by an
    identified account when the request was built. What must never exist is a
    path where an **unauthenticated** party names the recipient.

    Written in Phase 2B as a tripwire for routes that did not exist yet; Phase
    8 shipped them, so it now checks what it always meant to.
    """
    from django.urls import get_resolver

    from apps.core.permissions import IsAccount

    routes = [
        (str(pattern.pattern), pattern.callback)
        for entry in get_resolver().url_patterns
        for pattern in getattr(entry, "url_patterns", [entry])
        if "sign-request" in str(pattern.pattern)
        or "recipients" in str(pattern.pattern)
    ]
    assert routes, "the sign-request routes vanished — this gate is now vacuous"
    for route, callback in routes:
        view = getattr(callback, "cls", None) or getattr(callback, "view_class", None)
        assert view is not None, route
        assert IsAccount in getattr(view, "permission_classes", []), (
            f"{route} can name an email recipient without an account (§17e, §21.3)"
        )


def test_guest_flows_send_no_mail(guest, fixture_bytes):
    from django.core import mail

    doc = _upload(guest, fixture_bytes).json()
    guest.post(
        f"/api/documents/{doc['id']}/operations/",
        {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90}},
        format="json",
    )
    guest.post("/api/guest/session/", {}, format="json")
    assert mail.outbox == []
