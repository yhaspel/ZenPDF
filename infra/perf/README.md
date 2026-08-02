# Load smoke (§10.2)

One command, and a number the deployed host still owes you.

```bash
# 1. Relax the throttles for the run only — see the locustfile docstring for
#    why turning them off beats raising them. `grep -q` first, because an
#    `infra/.env` created before this existed has no such line and a bare
#    `sed` would silently match nothing.
grep -q '^THROTTLES_DISABLED=' infra/.env || echo 'THROTTLES_DISABLED=false' >> infra/.env
python3 - <<'EOF'
import pathlib, re
p = pathlib.Path('infra/.env')
p.write_text(re.sub(r'^THROTTLES_DISABLED=.*$', 'THROTTLES_DISABLED=true',
                    p.read_text(), flags=re.M))
EOF
docker compose -f infra/docker-compose.yml up -d api

# 2. Run it. Start at 50 users on a laptop — see "the dev stack's ceiling".
docker compose -f infra/docker-compose.yml --profile perf run --rm perf \
  -f /mnt/locust/locustfile.py --host http://api:8000 \
  --headless --users 50 --spawn-rate 10 --run-time 2m

# 3. Put them back. This is not optional.
python3 - <<'EOF'
import pathlib, re
p = pathlib.Path('infra/.env')
p.write_text(re.sub(r'^THROTTLES_DISABLED=.*$', 'THROTTLES_DISABLED=false',
                    p.read_text(), flags=re.M))
EOF
docker compose -f infra/docker-compose.yml up -d api
```

(Python rather than `sed -i`, because the in-place flag differs between BSD
and GNU and the BSD form eats the script argument on Linux.)

## The dev stack's ceiling — read this before believing a failure

The compose `api` service runs `manage.py runserver`, which is one thread per
live connection, and `CONN_MAX_AGE=600` gives each thread its own Postgres
backend against `max_connections=100`. At 200 users the *database* runs out of
connections before the API runs out of anything interesting, `/api/health/`
starts reporting `db: false`, and what you have measured is the ceiling rather
than the product. The connections drain by themselves within a minute or so.

So: **50 users on the dev stack**, and 200 only against a deployment running
gunicorn, which is what the number is for. A run that aborts now says so and
exits non-zero rather than printing a five-second verdict as if it were three
minutes.

The run prints a verdict per endpoint against the 150 ms p95 budget and exits
non-zero if any exceeded it **or** if anything was throttled — a p95 computed
over rate-limit rejections is not a p95.

## What this measures, and what it does not

A "light user" is §21's traffic: a guest who landed on a tool page (config,
their own library, one job they poll) and a signed-in user working the
dashboard (documents, versions, jobs, sign-requests, usage). Nothing uploads
and nothing converts — the budget is about *metadata* endpoints. Throughput
under real work is a different test and belongs on real infrastructure.

**It runs from inside the compose network on purpose.** `GET /api/config/` is
2.5 ms from a sibling container and 19–102 ms through Docker Desktop's port
forward; `/api/documents/` is 59 ms in-network and up to 2 000 ms from the
host. A host-side run measures the port proxy and calls it the API.

**A laptop number is not a production number, and the library matters more than
the machine.** `PERF_EMAIL` defaults to the seeded admin, whose library is
four documents. Point it at an account with a realistic number before believing
the `/api/documents/` figure:

```bash
PERF_EMAIL=someone@example.com PERF_PASSWORD=… \
  docker compose -f infra/docker-compose.yml --profile perf run --rm perf
```

## Against the deployed host

Drop the profile and run locust directly with `--host https://<host>`. Two
differences: the demo-job endpoint 404s there and the script falls back, and
**the throttles stay on** — so keep `--users` under the tier budget or the
number means nothing. That run is what closes §10.2's p95 line; this one is
what stops it regressing in the meantime.
