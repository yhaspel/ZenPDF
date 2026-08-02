"""Error reporting (§10.4).

Wired in every environment and **active in none of them by default**: with no
`SENTRY_DSN` this returns immediately, imports nothing and opens no socket. So
the switch is an environment variable rather than a deploy.

Two things it does that the default configuration does not:

* **Scrubs PII before the event leaves the process.** `send_default_pii` stays
  off, and `before_send` drops the parts of a request that carry other people's
  documents — headers with credentials, the request body, cookies, and query
  strings. A crash report from this product must not be a copy of somebody's
  contract, and "we will remember not to look" is not a control.
* **Carries the correlation ids**, so an event in Sentry can be traced back to
  the log lines and the job that produced it.
"""
from __future__ import annotations

import logging

from django.conf import settings

logger = logging.getLogger(__name__)

#: Headers that must never leave the process, whatever the SDK's defaults say.
_SENSITIVE_HEADERS = {
    "authorization", "cookie", "set-cookie", "x-guest-token",
    "x-captcha-token", "x-csrftoken",
}


def _before_send(event, hint):
    from .logging import job_id_var, principal_var, request_id_var

    request = event.get("request") or {}
    if request:
        headers = request.get("headers") or {}
        request["headers"] = {
            k: v for k, v in headers.items()
            if k.lower() not in _SENSITIVE_HEADERS
        }
        # A body is a document, a password, or a signature. None of them.
        request.pop("data", None)
        request.pop("cookies", None)
        request.pop("query_string", None)
        event["request"] = request
    # The user is identified by opaque id only — never the address.
    event.pop("user", None)

    tags = event.setdefault("tags", {})
    for name, var in (("request_id", request_id_var), ("principal", principal_var),
                      ("job_id", job_id_var)):
        value = var.get()
        if value:
            tags[name] = value
    return event


def init_sentry() -> bool:
    """Returns whether reporting was actually switched on."""
    dsn = getattr(settings, "SENTRY_DSN", "")
    if not dsn:
        return False
    try:
        import sentry_sdk
    except ImportError:
        # The package is a prod-only requirement; a dev machine that sets a DSN
        # should be told why nothing arrived rather than crash on startup.
        logger.warning("SENTRY_DSN is set but sentry-sdk is not installed.")
        return False

    sentry_sdk.init(
        dsn=dsn,
        environment=settings.SENTRY_ENVIRONMENT,
        release=settings.SENTRY_RELEASE or None,
        traces_sample_rate=settings.SENTRY_TRACES_SAMPLE_RATE,
        send_default_pii=False,
        before_send=_before_send,
    )
    return True
