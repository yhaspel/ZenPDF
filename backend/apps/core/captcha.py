"""Cloudflare Turnstile adapter (01-architecture.md §17c).

A guest is challenged **once per session, before the first METERED_OPS
operation only** — never for merge/split/compress/rotate. Friction on a first
merge is exactly the outcome the anonymous-first strategy exists to prevent
(§21.1), so the gate is keyed on `METERED_OPS`, never on `op.queue`.

Adapter shape, and off in dev: `CAPTCHA_ENABLED=false` short-circuits every
check, so the flag can be tightened in production without shipping new code.
"""
from __future__ import annotations

from django.conf import settings
from django.utils import timezone

from .exceptions import CaptchaRequired
from .limits import is_metered
from .principals import is_guest

CAPTCHA_HEADER = "HTTP_X_CAPTCHA_TOKEN"


def enabled() -> bool:
    return bool(settings.CAPTCHA_ENABLED and settings.TURNSTILE_SECRET_KEY)


def verify_token(token: str, remote_ip: str = "") -> bool:
    """Verify a Turnstile token against Cloudflare. Network failure = reject."""
    if not token:
        return False
    import requests

    try:
        resp = requests.post(
            settings.TURNSTILE_VERIFY_URL,
            data={
                "secret": settings.TURNSTILE_SECRET_KEY,
                "response": token,
                **({"remoteip": remote_ip} if remote_ip else {}),
            },
            timeout=5,
        )
        return bool(resp.ok and resp.json().get("success") is True)
    except Exception:  # noqa: BLE001
        return False


def enforce(request, principal, op_type: str) -> None:
    """Raise `captcha_required` if this guest still owes a challenge.

    Cheap ops return immediately: only `METERED_OPS` are ever challenged.
    """
    if not enabled() or not is_metered(op_type) or not is_guest(principal):
        return
    if principal.captcha_passed_at is not None:
        return

    from .authentication import client_ip

    token = request.META.get(CAPTCHA_HEADER, "")
    if verify_token(token, client_ip(request)):
        now = timezone.now()
        principal.captcha_passed_at = now
        type(principal).objects.filter(pk=principal.pk).update(captcha_passed_at=now)
        return
    raise CaptchaRequired()
