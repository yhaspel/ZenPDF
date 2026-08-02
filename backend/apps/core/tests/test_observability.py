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
        # Named, because the job id is only bound for tasks whose first
        # argument actually is one.
        name = "apps.documents.tasks.run_operation"
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

    from apps.core.tasks import (
        HEARTBEAT_KEY,
        HEARTBEAT_QUEUES,
        worker_heartbeat,
    )

    for queue in HEARTBEAT_QUEUES:
        cache.delete(f"{HEARTBEAT_KEY}:{queue}")
    body = anon.get("/api/health/").json()
    assert body["checks"]["workers"] is False
    assert body["status"] == "degraded"

    # One lane alive is not "the workers are fine": a dead `heavy` worker
    # leaves OCR piling up while everything else looks normal.
    worker_heartbeat("default")
    assert anon.get("/api/health/").json()["checks"]["workers"] is False

    for queue in HEARTBEAT_QUEUES:
        worker_heartbeat(queue)
    body = anon.get("/api/health/").json()
    assert body["checks"]["workers"] is True
    # The *detail* is not public: queue depths and per-lane ages tell anybody
    # watching when the heavy lane saturates and which worker died.
    assert "queues" not in body
    assert "worker_heartbeat_age_seconds" not in body


def test_a_stale_heartbeat_counts_as_dead(anon):
    import time

    from django.core.cache import cache

    from apps.core.tasks import (
        HEARTBEAT_KEY,
        HEARTBEAT_QUEUES,
        HEARTBEAT_STALE_SECONDS,
    )

    stale = time.time() - HEARTBEAT_STALE_SECONDS - 1
    for queue in HEARTBEAT_QUEUES:
        cache.set(f"{HEARTBEAT_KEY}:{queue}", stale, 3600)
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


def test_a_crash_report_carries_no_signing_token_and_no_address_anywhere():
    """The four places the first version of the scrubber did not look.

    A signing token is a bearer capability *in the URL path*, so a 500 in a
    ceremony view would have shipped a working signing link to a third-party
    service — and a Django IntegrityError puts the address in the exception
    message itself.
    """
    from apps.core.observability import _before_send

    event = {
        "request": {
            "url": "https://zenpdf.example/api/public/sign/"
                   "SECRET-SIGNING-TOKEN-abc123def456ghi789jkl/complete/",
            "headers": {"Referer": "https://zenpdf.example/s/TOKENabc123"},
            "env": {"REMOTE_ADDR": "203.0.113.7"},
        },
        "exception": {"values": [{
            "type": "IntegrityError",
            "value": "Key (email)=(victim@example.com) already exists",
        }]},
        "breadcrumbs": [{"message": "SELECT title FROM documents_document"}],
        "extra": {"document_title": "Divorce settlement - Jane Doe.pdf"},
        "logentry": {"message": "failed for alice@example.com",
                     "params": ["alice@example.com"]},
    }
    scrubbed = _before_send(event, None)

    assert "SECRET-SIGNING-TOKEN" not in scrubbed["request"]["url"]
    assert "/api/public/sign/" in scrubbed["request"]["url"], "shape is kept"
    assert "TOKENabc123" not in str(scrubbed["request"]["headers"])
    assert "env" not in scrubbed["request"]
    assert "victim@example.com" not in scrubbed["exception"]["values"][0]["value"]
    assert "IntegrityError" == scrubbed["exception"]["values"][0]["type"]
    assert "breadcrumbs" not in scrubbed
    assert "extra" not in scrubbed
    assert "alice@example.com" not in scrubbed["logentry"]["message"]
    assert "params" not in scrubbed["logentry"]


def test_the_beat_schedule_keeps_every_lane_reporting():
    """One entry per lane, each routed to the queue it reports on — otherwise
    the heartbeat only ever proves that one worker is alive."""
    from apps.core.tasks import HEARTBEAT_QUEUES, HEARTBEAT_STALE_SECONDS

    for queue in HEARTBEAT_QUEUES:
        schedule = settings.CELERY_BEAT_SCHEDULE[f"worker-heartbeat-{queue}"]
        assert schedule["task"] == "apps.core.tasks.worker_heartbeat"
        assert schedule["options"]["queue"] == queue
        assert schedule["args"] == (queue,)
        # Three missed beats before health calls it: one late run under load
        # is not an incident.
        assert HEARTBEAT_STALE_SECONDS >= schedule["schedule"] * 3


def test_health_degrades_rather_than_raising_when_the_cache_is_down(anon,
                                                                   monkeypatch):
    """A readiness probe that 500s when Redis is down tells the platform
    nothing — least of all that the database is fine and documents can still
    be read."""
    from django.core.cache import cache

    def unreachable(*_args, **_kwargs):
        raise ConnectionError("redis is down")

    monkeypatch.setattr(cache, "get", unreachable)
    resp = anon.get("/api/health/")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "degraded"
    assert body["checks"]["db"] is True
    assert body["checks"]["workers"] is False


def test_the_admin_gate_cannot_be_opened_with_a_header(client, settings):
    """`X-Forwarded-For` is client-supplied unless something trustworthy
    overwrote it — and nginx proxies only `/api/`, so admin is reached on
    gunicorn directly. One header must not be the whole gate."""
    settings.DEBUG = False
    settings.ADMIN_ENABLED = True
    settings.ADMIN_IP_ALLOWLIST = ["10.9.9.9"]

    assert client.get("/admin/").status_code == 404
    spoofed = client.get("/admin/", HTTP_X_FORWARDED_FOR="10.9.9.9")
    assert spoofed.status_code == 404, "a header opened the admin"

    # The real thing: the socket peer *and* the derived client both allowed.
    allowed = client.get("/admin/", REMOTE_ADDR="10.9.9.9")
    assert allowed.status_code != 404


def test_a_render_task_is_not_labelled_with_a_job_id_it_does_not_have():
    """Binding the first argument blindly labelled a thumbnail render with a
    *document* id — which looks like an answer and is not."""
    from apps.core import logging as zen_logging
    from config.celery import _bind_correlation, _clear_correlation

    _clear_correlation()

    class FakeTask:
        name = "apps.documents.tasks.generate_thumbnails_task"
        request = type("R", (), {"headers": {}})()

    _bind_correlation(task=FakeTask(), args=["11111111-2222-3333-4444-555555555555"])
    assert zen_logging.job_id_var.get() == ""

    class OperationTask:
        name = "apps.documents.tasks.run_operation"
        request = type("R", (), {"headers": {}})()

    _bind_correlation(task=OperationTask(), args=["job-1"])
    assert zen_logging.job_id_var.get() == "job-1"
    _clear_correlation()


def test_the_operational_detail_is_for_operators(api, user, anon):
    """A staff member (or an allowlisted address) gets the queue depths; the
    public readiness probe gets `status` and `checks` and nothing else."""
    from apps.core.tasks import HEARTBEAT_QUEUES, worker_heartbeat

    for queue in HEARTBEAT_QUEUES:
        worker_heartbeat(queue)

    assert "queues" not in anon.get("/api/health/").json()

    user.is_staff = True
    user.save(update_fields=["is_staff"])
    body = api.get("/api/health/").json()
    assert set(body["queues"]) == set(HEARTBEAT_QUEUES)
    assert set(body["workers"]) == set(HEARTBEAT_QUEUES)
    assert body["worker_heartbeat_age_seconds"] < 5


# --------------------------------------------------------------------------- #
# Client-side crashes (§10.4) — reported to our own origin, not to a vendor
# --------------------------------------------------------------------------- #
def test_a_client_crash_becomes_a_log_line(anon, caplog):
    import logging

    with caplog.at_level(logging.ERROR, logger="apps.core.views"):
        resp = anon.post("/api/client-errors/", {
            "name": "TypeError",
            "message": "Cannot read properties of undefined",
            "stack": "at chunk-ABC123.js:1:4096",
            "route": "/app/doc/123",
        }, format="json")
    assert resp.status_code == 204
    assert "Cannot read properties of undefined" in caplog.text


def test_a_client_crash_report_needs_no_credential(anon, guest):
    """A crash report must not identify the browser that sent it."""
    for client in (anon, guest):
        resp = client.post("/api/client-errors/",
                           {"name": "Error", "message": "boom"}, format="json")
        assert resp.status_code == 204


def test_the_server_re_scrubs_what_the_browser_sent(anon, caplog):
    """The browser's copy of the redaction rules is a convenience, not the
    control — this endpoint accepts input from anybody."""
    import logging

    with caplog.at_level(logging.ERROR, logger="apps.core.views"):
        anon.post("/api/client-errors/", {
            "name": "Error",
            "message": "failed for alice@example.com",
            "route": "/s/SECRETTOKENabcdefghijklmnopqrstuvwxyz012345",
            "stack": "at /api/public/sign/SECRETTOKENabcdefghijklmnop/complete/",
        }, format="json")
    assert "alice@example.com" not in caplog.text
    assert "SECRETTOKEN" not in caplog.text
    # …and enough shape survives to be worth reading.
    assert "/s/" in caplog.text or "[token]" in caplog.text


def test_an_empty_report_is_accepted_and_dropped(anon):
    assert anon.post("/api/client-errors/", {}, format="json").status_code == 204


def test_a_crash_report_cannot_forge_a_log_line(anon, caplog):
    """The endpoint is unauthenticated and its fields reach a log line. A
    newline in the message is a second, forged entry — the rule this project
    already applies to the inbound request id, for a much smaller field."""
    import logging

    with caplog.at_level(logging.ERROR, logger="apps.core.views"):
        anon.post("/api/client-errors/", {
            "name": "Error",
            "message": "real crash\nINFO Payment approved for admin=true",
            "route": "/x\r\nCRITICAL forged",
        }, format="json")
    for record in caplog.records:
        assert "\n" not in record.getMessage()
        assert "\r" not in record.getMessage()
    assert "Payment approved" in caplog.text, "the text itself is kept"


def test_a_typo_in_LOG_FORMAT_does_not_take_the_process_down():
    """It used to raise `Unable to configure handler 'console'` at import
    time, which is an environment typo killing a deploy before it can say
    why."""
    import logging.config

    from django.conf import settings

    config = {**settings.LOGGING}
    config["handlers"] = {**config["handlers"]}
    config["handlers"]["console"] = {**config["handlers"]["console"],
                                     "formatter": "json"}
    logging.config.dictConfig(config)  # must not raise
