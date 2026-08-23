"""L3 — the concurrency slot, against a database that actually has row locks.

`documents/views.py::_concurrency_slot` wraps the count and the insert in one
transaction holding the principal's own row, because count-then-create is not a
check when two requests arrive together: both count `limit - 1`, both create,
and the tier ceiling turns out to be advisory.

The hermetic suite proves the *path* and not the *lock*. It runs on SQLite,
where `connection.features.has_select_for_update` is False, so the branch that
does the work is never taken and there is no concurrency to protect anyway —
`test_race_and_window_polish.py` says as much in its own docstring. That left
the fix asserted by a test that could not fail if the lock were deleted.

This file stages the race for real: two threads, two connections, one Postgres
row, twenty times. It is `@PG_ONLY` for the same reason the query plans are,
and it runs in the same `./infra/test.sh --pg` leg.
"""
from __future__ import annotations

import threading

import pytest
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection, connections
from rest_framework.test import APIClient

#: Real commits, seen from another connection — the whole point. The default
#: wraps each test in a transaction nothing outside it can see, which would make
#: the second thread block for ever on a row the first has not committed.
pytestmark = pytest.mark.django_db(transaction=True)

#: Selected by `--pg` through `pg_only`; skipped elsewhere by the skipif. Same
#: pairing as `test_performance.py`, and for the same reason — see its note.
_NEEDS_PG = pytest.mark.skipif(
    connection.vendor != "postgresql",
    reason="SQLite has no row locks and no concurrency; the lock under test "
           "does not exist there. Exercised by ./infra/test.sh --pg")


def PG_ONLY(func):  # noqa: N802 - it reads as a marker at every call site
    return pytest.mark.pg_only(_NEEDS_PG(func))

#: Enough runs that a lock that works by luck stops working. Twenty pairs took
#: ~2 s locally; a hundred would be a nicer number and a worse gate.
ITERATIONS = 20


class _Fired:
    """Two threads' answers, keyed by thread index."""

    def __init__(self):
        self.status: dict[int, int] = {}
        self.code: dict[int, str] = {}
        self.error: dict[int, BaseException] = {}


def _fire(index: int, token: str, doc_id: str, gate: threading.Barrier,
          out: _Fired) -> None:
    """One POST, released at the same instant as its twin."""
    try:
        client = APIClient()
        gate.wait(timeout=20)
        response = client.post(
            f"/api/documents/{doc_id}/operations/",
            {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90}},
            format="json", HTTP_X_GUEST_TOKEN=token,
        )
        out.status[index] = response.status_code
        body = response.json() if response.content else {}
        out.code[index] = (body.get("error") or {}).get("code", "")
    except BaseException as exc:  # noqa: BLE001 - re-raised by the caller
        out.error[index] = exc
    finally:
        # Every thread that touched the ORM opened its own connection. Leaving
        # them behind is how a long test session runs Postgres out of its
        # hundred-connection budget — measured on 2026-08-22, and it presents
        # as seven unrelated e2e specs failing at `registerAndLogin`.
        connections.close_all()


@pytest.fixture
def _no_broker(monkeypatch):
    """Create the Job row; send nothing.

    The slot counts QUEUED and RUNNING jobs, so the race only exists while the
    first job is still queued. Letting the task dispatch would either hand the
    message to the dev workers (which are pointed at a different database and
    would fail it) or, under eager execution, finish the job inside the request
    and free the slot before the second thread ever looked.
    """
    from apps.documents import tasks

    class _Sent:
        id = "not-dispatched"

    monkeypatch.setattr(tasks.run_operation, "apply_async",
                        lambda *args, **kwargs: _Sent())


@pytest.fixture
def _guest_document(fixture_bytes, settings):
    """A committed guest session holding one document, and its raw token."""
    import copy

    tiers = copy.deepcopy(settings.TIERS)
    tiers["guest"]["max_concurrent_jobs"] = 1
    settings.TIERS = tiers

    client = APIClient()
    upload = SimpleUploadedFile("text.pdf", fixture_bytes("text.pdf"),
                                content_type="application/pdf")
    response = client.post("/api/documents/", {"file": upload}, format="multipart")
    assert response.status_code == 201, response.content
    token = response.headers["X-Guest-Token"]
    return token, response.json()["id"]


@PG_ONLY
def test_two_simultaneous_operations_fill_exactly_one_slot(_guest_document,
                                                           _no_broker):
    """One 202 and one 429 `quota_exceeded`, every time.

    Before `_concurrency_slot` held the row, the losing request also got a 202:
    both counted zero active jobs before either had inserted one. The tier said
    one concurrent job and the principal got two — which is the whole of what a
    concurrency limit is for.
    """
    from apps.jobs.models import Job

    token, doc_id = _guest_document
    accepted_total = 0

    for iteration in range(ITERATIONS):
        # The guest throttle is 40/min and this loop makes 40 POSTs. Clearing
        # the bucket keeps the 429 under test the *quota* one — otherwise the
        # last iterations would refuse for a reason this test is not about.
        cache.clear()
        Job.objects.all().delete()

        out = _Fired()
        gate = threading.Barrier(2)
        threads = [threading.Thread(target=_fire, args=(i, token, doc_id, gate, out))
                   for i in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
            assert not thread.is_alive(), f"iteration {iteration}: a thread hung"

        if out.error:
            raise out.error[next(iter(out.error))]

        statuses = sorted(out.status.values())
        assert statuses == [202, 429], (
            f"iteration {iteration}: expected one 202 and one 429, got {statuses}. "
            f"Two 202s mean the slot was handed out twice."
        )
        refused = [i for i, s in out.status.items() if s == 429]
        assert out.code[refused[0]] == "quota_exceeded", (
            f"iteration {iteration}: refused with "
            f"{out.code[refused[0]]!r}, not the concurrency quota"
        )
        assert Job.objects.count() == 1, (
            f"iteration {iteration}: {Job.objects.count()} job rows exist; "
            f"the loser of the race created one anyway"
        )
        accepted_total += 1

    assert accepted_total == ITERATIONS


@PG_ONLY
def test_the_lock_is_actually_taken_on_this_backend():
    """The guard on the guard.

    `_concurrency_slot` only locks when `has_select_for_update` is True. If that
    were ever False here, the test above would pass by serialization luck and
    prove nothing — so the precondition is asserted rather than assumed.
    """
    assert connection.features.has_select_for_update, (
        "this backend has no SELECT … FOR UPDATE, so the race the test above "
        "stages cannot be lost and the test cannot fail"
    )
