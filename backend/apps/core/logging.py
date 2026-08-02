"""Structured logs with correlation (§10.4).

One line of JSON per event, carrying the three ids that make a production
incident answerable: **request**, **principal** and **job**. Without them a log
is a pile of sentences from twelve containers; with them, one grep over a
request id tells the whole story — the API call, the worker that picked it up,
and the operation that failed.

The ids ride on a `contextvars.ContextVar`, so they follow the work across
`await` and across Celery's own threads without being threaded through every
function signature. The filter reads them at emit time; nothing has to
remember to pass them.

Deliberately **not** a dependency: `python-json-logger` and `structlog` both do
more than this needs, and a formatter that has to be correct under a hostile
input parser is better as thirty lines we can read.
"""
from __future__ import annotations

import contextvars
import json
import logging
import uuid

#: Set by the request middleware, and by the Celery task prerun signal.
request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar(
    "zen_request_id", default="")
principal_var: contextvars.ContextVar[str] = contextvars.ContextVar(
    "zen_principal", default="")
job_id_var: contextvars.ContextVar[str] = contextvars.ContextVar(
    "zen_job_id", default="")


def new_request_id() -> str:
    return uuid.uuid4().hex[:16]


def bind(*, request_id: str = "", principal: str = "", job_id: str = "") -> None:
    if request_id:
        request_id_var.set(request_id)
    if principal:
        principal_var.set(principal)
    if job_id:
        job_id_var.set(job_id)


class CorrelationFilter(logging.Filter):
    """Attaches the current ids to every record, empty when there are none."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get()
        record.principal = principal_var.get()
        record.job_id = job_id_var.get()
        return True


#: Attributes `logging` puts on every record. Anything *not* here was passed by
#: the caller as `extra=` and belongs in the payload.
_STANDARD = frozenset(logging.LogRecord("", 0, "", 0, "", None, None).__dict__) | {
    "asctime", "message", "request_id", "principal", "job_id", "taskName",
}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        for key in ("request_id", "principal", "job_id"):
            value = getattr(record, key, "")
            if value:
                payload[key] = value
        for key, value in record.__dict__.items():
            if key not in _STANDARD and not key.startswith("_"):
                # Structured extras, as long as they survive a round trip.
                try:
                    json.dumps(value)
                except (TypeError, ValueError):
                    value = repr(value)
                payload[key] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


class RequestCorrelationMiddleware:
    """Binds the ids for the duration of one request and echoes the id back.

    An inbound `X-Request-ID` is honoured so a reverse proxy's id (or a client
    debugging a report) stitches to ours, but it is **truncated and stripped**
    of anything that is not hex-ish: it lands in log lines, and a log line is a
    place attacker-controlled text does not belong.
    """

    HEADER = "HTTP_X_REQUEST_ID"

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        incoming = (request.META.get(self.HEADER) or "")[:64]
        request_id = "".join(c for c in incoming if c.isalnum() or c in "-_") \
            or new_request_id()
        token = request_id_var.set(request_id)
        principal_token = principal_var.set("")
        request.request_id = request_id
        try:
            response = self.get_response(request)
        finally:
            # Bound *after* the view has resolved the principal, so the ids on
            # the response and on any log line the view wrote agree.
            request_id_var.reset(token)
            principal_var.reset(principal_token)
        response["X-Request-ID"] = request_id
        return response


def celery_headers() -> dict:
    """The correlation ids, shaped for `apply_async(headers=…)` (§10.4).

    Passing them explicitly rather than through the message body keeps them out
    of task signatures — a task should not grow a `request_id` parameter to be
    traceable — and Celery echoes headers back on retries for free.
    """
    return {
        "zen_request_id": request_id_var.get(),
        "zen_principal": principal_var.get(),
    }
