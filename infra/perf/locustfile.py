"""§10.2 load smoke — API p95 for metadata endpoints, 200 light users.

**Run it from inside the compose network.** Measured on the dev stack,
`GET /api/config/` is 2.5 ms from a sibling container and 19–102 ms through
Docker Desktop's port forward; `GET /api/documents/` is 59 ms in-network and up
to 2 000 ms from the host. A host-side run reports the port proxy and calls it
the API. The `perf` compose service targets `http://api:8000` for that reason.

A "light user" here is §21's traffic, not a synthetic one: a **guest** who
landed on a prerendered tool page (config, their own library, one job they then
poll) and a **signed-in** user working the dashboard (documents, versions,
jobs, sign-requests, usage). Nothing uploads and nothing converts — the budget
is about metadata endpoints. Throughput under real work is a different test and
belongs on real infra.

**Throttles.** Guest limits key on the token *and* a salted IP hash and the
stricter wins (§16), so 200 users from one container share one bucket and a
naive run measures 429s. Set `THROTTLES_DISABLED=true` on the api service for
the run (see README.md) — do not raise the numbers instead: DRF keeps the full
timestamp history per key and rewrites it every request, so a 100000/min bucket
puts a 100000-element list in Redis on the hot path and you measure the
throttle. Any 429 here is a **failure** and makes the run exit non-zero,
because a p95 computed over rate-limit rejections is not a p95.
"""
from __future__ import annotations

import os

import requests
from locust import HttpUser, between, events, task

API = "/api"
BUDGET_MS = int(os.getenv("PERF_P95_BUDGET_MS", "150"))
EMAIL = os.getenv("PERF_EMAIL", "admin@zenpdf.local")
PASSWORD = os.getenv("PERF_PASSWORD", "admin12345")

#: The endpoints §10.2's budget is about. Everything else in the file is load,
#: not a gate — a real user's other traffic is part of what the API is doing
#: while these are measured.
METADATA = (
    "GET /api/config/",
    "GET /api/documents/",
    "GET /api/documents/{id}/versions/",
    "GET /api/jobs/",
    "GET /api/jobs/{id}/",
    "GET /api/sign-requests/",
    "GET /api/users/me/usage/",
)

_access_token: str | None = None
_throttled = 0


@events.test_start.add_listener
def _login_once(environment, **_):
    """One login for the whole run, deliberately.

    `/api/auth/login/` carries its own per-IP throttle (`AuthThrottle`, 10/min
    in production) which `THROTTLES_DISABLED` does *not* clear, so 200 logins
    during the ramp would spend it on the first ten and the rest of the run
    would be unauthenticated. One account is also honest about what this
    measures: a shared library, warm in Postgres' cache. Point `PERF_EMAIL` at
    an account with a realistic number of documents before believing the
    `GET /api/documents/` figure.
    """
    global _access_token
    try:
        r = requests.post(
            f"{environment.host}{API}/auth/login/",
            json={"email": EMAIL, "password": PASSWORD}, timeout=30,
        )
        _access_token = r.json()["access"] if r.status_code == 200 else None
    except Exception as exc:  # noqa: BLE001
        _access_token = None
        print(f"[perf] login error: {exc}")
    if _access_token is None:
        print("[perf] login failed — the signed-in scenario will not run")


def _get(client, path, name, headers):
    """A GET whose 429 is a failure rather than a fast success."""
    global _throttled
    with client.get(path, name=name, headers=headers, catch_response=True) as r:
        if r.status_code == 429:
            _throttled += 1
            r.failure("429 throttled — set THROTTLES_DISABLED=true on api and rerun")
        elif r.status_code >= 400:
            r.failure(f"HTTP {r.status_code}")
        else:
            r.success()
        return r


class GuestVisitor(HttpUser):
    """The majority of real traffic (§21.1): nobody signed in."""

    weight = 7
    wait_time = between(1, 3)

    def on_start(self):
        self.headers: dict[str, str] = {}
        self.job_id: str | None = None
        # The SPA's bootstrap call, before any token exists.
        _get(self.client, f"{API}/config/", "GET /api/config/", self.headers)
        with self.client.post(f"{API}/guest/session/", name="POST /api/guest/session/",
                              catch_response=True) as r:
            token = r.headers.get("X-Guest-Token", "")
            if r.status_code in (200, 201) and token:
                self.headers = {"X-Guest-Token": token}
                r.success()
            else:
                r.failure(f"no guest token (HTTP {r.status_code})")
                self.environment.runner.quit()
                return
        # One real job so the poll below polls something. The endpoint is
        # DEBUG-only (`jobs/views.py`), so on a deployed host this 404s and the
        # user falls back to polling the list — which is what the dashboard
        # does anyway.
        with self.client.post(f"{API}/jobs/demo/", headers=self.headers,
                              name="POST /api/jobs/demo/", catch_response=True) as r:
            if r.status_code == 202:
                self.job_id = r.json()["id"]
                r.success()
            elif r.status_code in (404, 429):
                r.success()   # expected on a deployment / a throttled tier
            else:
                r.failure(f"HTTP {r.status_code}")

    @task(4)
    def poll_job(self):
        if self.job_id:
            _get(self.client, f"{API}/jobs/{self.job_id}/",
                 "GET /api/jobs/{id}/", self.headers)
        else:
            _get(self.client, f"{API}/jobs/", "GET /api/jobs/", self.headers)

    @task(3)
    def config(self):
        _get(self.client, f"{API}/config/", "GET /api/config/", self.headers)

    @task(2)
    def library(self):
        _get(self.client, f"{API}/documents/?page=1",
             "GET /api/documents/", self.headers)

    @task(1)
    def usage(self):
        _get(self.client, f"{API}/users/me/usage/",
             "GET /api/users/me/usage/", self.headers)


class SignedInUser(HttpUser):
    """An account on the dashboard. Shares one token (see `_login_once`)."""

    weight = 3
    wait_time = between(1, 3)

    def on_start(self):
        if _access_token is None:
            self.environment.runner.quit()
            return
        self.headers = {"Authorization": f"Bearer {_access_token}"}
        self.doc_id: str | None = None
        r = _get(self.client, f"{API}/documents/?page=1",
                 "GET /api/documents/", self.headers)
        if r.status_code == 200:
            results = r.json().get("results") or []
            self.doc_id = results[0]["id"] if results else None

    @task(4)
    def library(self):
        _get(self.client, f"{API}/documents/?page=1",
             "GET /api/documents/", self.headers)

    @task(3)
    def jobs(self):
        _get(self.client, f"{API}/jobs/", "GET /api/jobs/", self.headers)

    @task(2)
    def versions(self):
        if self.doc_id:
            _get(self.client, f"{API}/documents/{self.doc_id}/versions/",
                 "GET /api/documents/{id}/versions/", self.headers)

    @task(2)
    def sign_requests(self):
        _get(self.client, f"{API}/sign-requests/",
             "GET /api/sign-requests/", self.headers)

    @task(1)
    def usage(self):
        _get(self.client, f"{API}/users/me/usage/",
             "GET /api/users/me/usage/", self.headers)


@events.quitting.add_listener
def _verdict(environment, **_):
    """Print the §10.2 verdict and set the exit code, so this is CI-able."""
    failed = []
    print(f"\n== §10.2 metadata budget (p95 <= {BUDGET_MS} ms) ==")
    for name in METADATA:
        entry = environment.stats.get(name, "GET")
        if not entry.num_requests:
            continue
        p95 = entry.get_response_time_percentile(0.95)
        ok = p95 is not None and p95 <= BUDGET_MS
        failed.append(name) if not ok else None
        print(f"  {'PASS' if ok else 'FAIL'}  {name:36s} "
              f"n={entry.num_requests:6d}  p95={p95:6.0f} ms")
    if _throttled:
        print(f"  FAIL  {_throttled} request(s) were throttled (429). This run "
              f"measured rate limiting, not the API — set THROTTLES_DISABLED=true "
              f"on the api service and rerun.")
    if environment.stats.total.num_failures and not _throttled:
        print(f"  NOTE  {environment.stats.total.num_failures} non-429 failures.")
    environment.process_exit_code = 1 if (failed or _throttled) else 0
