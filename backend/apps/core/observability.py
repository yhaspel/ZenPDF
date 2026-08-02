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
import re

from django.conf import settings

logger = logging.getLogger(__name__)

#: Headers that must never leave the process, whatever the SDK's defaults say.
_SENSITIVE_HEADERS = {
    "authorization", "cookie", "set-cookie", "x-guest-token",
    "x-captcha-token", "x-csrftoken",
}


#: Anything that looks like an address, or like one of our capability tokens.
#: A signing token is a *bearer credential in the URL path*, so an unhandled
#: 500 in a ceremony view would otherwise ship a working signing link to a
#: third-party service.
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_TOKEN_PATH = re.compile(
    # `/s/{token}` is the SPA's own ceremony route, which arrives as a Referer.
    r"(/(?:public/sign|mail/unsubscribe|verify-email|s)/)[^/?#\s]+")
#: 32+ URL-safe characters with no spaces: our tokens, and nothing a human
#: writes in an error message.
_LONG_TOKEN = re.compile(r"\b[A-Za-z0-9_-]{32,}\b")


def _redact(value):
    """Strip addresses and capability tokens out of a free-text string."""
    if not isinstance(value, str):
        return value
    value = _TOKEN_PATH.sub(r"\1[token]", value)
    value = _EMAIL.sub("[email]", value)
    return _LONG_TOKEN.sub("[token]", value)


def _before_send(event, hint):
    from .logging import job_id_var, principal_var, request_id_var

    request = event.get("request") or {}
    if request:
        headers = request.get("headers") or {}
        request["headers"] = {
            k: _redact(v) for k, v in headers.items()
            if k.lower() not in _SENSITIVE_HEADERS
        }
        # A body is a document, a password, or a signature. None of them.
        request.pop("data", None)
        request.pop("cookies", None)
        request.pop("query_string", None)
        request.pop("env", None)
        # The URL keeps its shape — which view broke is the whole point — with
        # the capability taken out of the path.
        if request.get("url"):
            request["url"] = _redact(request["url"])
        event["request"] = request

    # The user is identified by opaque id only — never the address.
    event.pop("user", None)
    # Breadcrumbs are log records and SQL by default: this product's log
    # records name documents and its SQL carries their titles. The stack trace
    # is what an incident needs; the trail is where the contents leak.
    event.pop("breadcrumbs", None)
    # `extra` is whatever a caller attached, which is exactly the wrong thing
    # to trust with somebody else's contract.
    event.pop("extra", None)

    for entry in (event.get("exception") or {}).get("values") or []:
        # A Django IntegrityError puts the address in the message:
        # `Key (email)=(alice@example.com) already exists`.
        if entry.get("value"):
            entry["value"] = _redact(entry["value"])
    logentry = event.get("logentry")
    if logentry:
        logentry["message"] = _redact(logentry.get("message"))
        logentry.pop("params", None)

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
