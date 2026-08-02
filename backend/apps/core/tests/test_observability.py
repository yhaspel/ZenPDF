"""Logs, health and error reporting (§10.4).

What these assert is the thing an incident actually needs: that one id ties an
API call to the worker that ran it, that a stack whose workers are dead does
not report itself healthy, and that a crash report cannot carry somebody's
document out of the building.
"""
import json
import logging

import pytest
from django.conf import settings

pytestmark = pytest.mark.django_db


# --------------------------------------------------------------------------- #
# Correlation
# --------------------------------------------------------------------------- #
def test_every_response_carries_a_request_id(anon):
    resp = anon.get("/api/health/live")
    assert resp["X-Request-ID"]


def test_an_inbound_request_id_is_honoured_but_sanitised(anon):
    """A proxy's id stitches to ours — after the parts that do not belong in a
    log line are removed."""
    resp = anon.get("/api/health/live", HTTP_X_REQUEST_ID="abc-123")
    assert resp["X-Request-ID"] == "abc-123"

    hostile = anon.get("/api/health/live",
                       HTTP_X_REQUEST_ID='x" injected\nlevel=CRITICAL')
    assert resp["X-Request-ID"] != hostile["X-Request-ID"]
    assert hostile["X-Request-ID"] == "xinjectedlevelCRITICAL"


def test_the_json_formatter_emits_one_parseable_line_with_the_ids():
    from apps.core.logging import CorrelationFilter, JsonFormatter, bind

    bind(request_id="rid-1", principal="user:42", job_id="job-9")
    record = logging.LogRecord("zenpdf.test", logging.INFO, __file__, 1,
                               "operation finished", None, None)
    record.op_type = "merge"
    CorrelationFilter().filter(record)

    payload = json.loads(JsonFormatter().format(record))
    assert payload["message"] == "operation finished"
    assert payload["request_id"] == "rid-1"
    assert payload["principal"] == "user:42"
    assert payload["job_id"] == "job-9"
    # Structured extras survive, so a log search can filter on them.
    assert payload["op_type"] == "merge"


def test_a_log_line_never_names_the_account_it_describes(api, user, monkeypatch):
    """The principal is an opaque id. An address in a log line is an address
    in a log aggregator, a screenshot and a support ticket."""
    from apps.core import authentication

    bound = []
    monkeypatch.setattr(authentication.zen_logging, "bind",
                        lambda **kwargs: bound.append(kwargs))

    api.get("/api/users/me/")
    assert bound == [{"principal": f"user:{user.pk}"}]
    assert user.email not in bound[0]["principal"]


def test_the_ids_reach_the_worker(monkeypatch):
    """A request id that stops at the API boundary answers half the question."""
    from apps.core import logging as zen_logging

    zen_logging.bind(request_id="rid-2", principal="guest:7")
    headers = zen_logging.celery_headers()
    assert headers == {"zen_request_id": "rid-2", "zen_principal": "guest:7"}

    from config.celery import _bind_correlation, _clear_correlation

    _clear_correlation()

    class FakeRequest:
        pass

    class FakeTask:
        request = FakeRequest()

    FakeTask.request.headers = headers
    _bind_correlation(task=FakeTask(), args=["job-123"])
    assert zen_logging.request_id_var.get() == "rid-2"
    assert zen_logging.principal_var.get() == "guest:7"
    assert zen_logging.job_id_var.get() == "job-123"
    _clear_correlation()


# --------------------------------------------------------------------------- #
# Health
# --------------------------------------------------------------------------- #
def test_liveness_answers_without_touching_a_dependency(anon, monkeypatch):
    """A liveness probe that checks Postgres restarts the API whenever Postgres
    hiccups, which turns one outage into two."""
    from apps.core import views

    def explode(*_args, **_kwargs):
        raise AssertionError("liveness must not check dependencies")

    monkeypatch.setattr(views.HealthView, "_db", explode)
    resp = anon.get("/api/health/live")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_health_reports_dead_workers(anon):
    """A green stack whose workers are dead looks identical from outside:
    requests succeed, jobs queue, nothing runs."""
    from django.core.cache import cache

    from apps.core.tasks import HEARTBEAT_KEY, worker_heartbeat

    cache.delete(HEARTBEAT_KEY)
    body = anon.get("/api/health/").json()
    assert body["checks"]["workers"] is False
    assert body["status"] == "degraded"

    worker_heartbeat()
    body = anon.get("/api/health/").json()
    assert body["checks"]["workers"] is True
    assert body["worker_heartbeat_age_seconds"] < 5


def test_a_stale_heartbeat_counts_as_dead(anon):
    import time

    from django.core.cache import cache

    from apps.core.tasks import HEARTBEAT_KEY, HEARTBEAT_STALE_SECONDS

    cache.set(HEARTBEAT_KEY, time.time() - HEARTBEAT_STALE_SECONDS - 1, 3600)
    assert anon.get("/api/health/").json()["checks"]["workers"] is False


def test_health_still_serves_when_a_dependency_is_down(anon, monkeypatch):
    """Only the database is a reason to take the site out of the load
    balancer — people can still read their documents without Gotenberg."""
    from apps.core import views

    monkeypatch.setattr(views.HealthView, "_gotenberg", lambda self: False)
    resp = anon.get("/api/health/")
    assert resp.status_code == 200
    assert resp.json()["status"] == "degraded"


# --------------------------------------------------------------------------- #
# Error reporting
# --------------------------------------------------------------------------- #
def test_sentry_stays_off_without_a_dsn(settings):
    from apps.core.observability import init_sentry

    settings.SENTRY_DSN = ""
    assert init_sentry() is False


def test_a_crash_report_carries_no_credential_no_body_and_no_address():
    """This product handles other people's contracts. A crash report must not
    be a copy of one."""
    from apps.core.logging import bind
    from apps.core.observability import _before_send

    bind(request_id="rid-3", principal="user:42")
    event = {
        "request": {
            "headers": {
                "Authorization": "Bearer secret-token",
                "X-Guest-Token": "guest-secret",
                "User-Agent": "Mozilla/5.0",
            },
            "data": {"password": "hunter2", "document": "<pdf bytes>"},
            "cookies": {"sessionid": "abc"},
            "query_string": "token=leaky",
        },
        "user": {"email": "alice@example.com", "id": "42"},
    }
    scrubbed = _before_send(event, None)

    assert "Authorization" not in scrubbed["request"]["headers"]
    assert "X-Guest-Token" not in scrubbed["request"]["headers"]
    assert scrubbed["request"]["headers"]["User-Agent"] == "Mozilla/5.0"
    assert "data" not in scrubbed["request"]
    assert "cookies" not in scrubbed["request"]
    assert "query_string" not in scrubbed["request"]
    assert "user" not in scrubbed
    # …and it is still traceable to the logs and the job.
    assert scrubbed["tags"]["request_id"] == "rid-3"
    assert scrubbed["tags"]["principal"] == "user:42"


def test_the_beat_schedule_keeps_the_heartbeat_running():
    schedule = settings.CELERY_BEAT_SCHEDULE["worker-heartbeat"]
    assert schedule["task"] == "apps.core.tasks.worker_heartbeat"
    # Three missed beats before health calls it: one late run under load is
    # not an incident.
    from apps.core.tasks import HEARTBEAT_STALE_SECONDS

    assert HEARTBEAT_STALE_SECONDS >= schedule["schedule"] * 3
