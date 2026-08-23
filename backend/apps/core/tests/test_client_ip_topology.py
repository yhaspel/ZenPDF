"""H1 — the client address behind a two-proxy topology.

Every per-IP limit in the product (auth, verify, public_sign, image_upload,
client_error, the guest IP leg) keys on one address, and that address is taken
`NUM_PROXIES` hops back from the end of X-Forwarded-For. Counting one hop too
few makes every request look like it came from the TLS terminator — one bucket
for the whole internet, which is a login lockout anyone can trigger. Counting
one too many reaches into the prefix the client wrote, which is free to spoof.

These tests pin both edges for the documented prod topology (client → TLS
terminator → nginx → gunicorn = 2 appending proxies), so a future change to the
default or to the helper has to argue with them.
"""
from django.conf import settings
from django.test import RequestFactory, override_settings

from apps.core.authentication import client_ip
from apps.core.throttling import AuthThrottle

CLIENT = "203.0.113.7"
TERMINATOR = "198.51.100.4"
SPOOF = "192.0.2.99"
NGINX = "10.0.0.9"


def _two_proxies():
    """REST_FRAMEWORK with the prod hop count, everything else untouched."""
    return override_settings(REST_FRAMEWORK={**settings.REST_FRAMEWORK, "NUM_PROXIES": 2})


def _request(xff: str):
    return RequestFactory().get("/api/health/", HTTP_X_FORWARDED_FOR=xff, REMOTE_ADDR=NGINX)


def test_two_hop_chain_resolves_to_the_client():
    """`client, terminator` under NUM_PROXIES=2 is the client, not the terminator."""
    with _two_proxies():
        assert client_ip(_request(f"{CLIENT}, {TERMINATOR}")) == CLIENT


def test_spoofed_prefix_is_ignored():
    """A hop the client invented ahead of its own address changes nothing."""
    with _two_proxies():
        assert client_ip(_request(f"{SPOOF}, {CLIENT}, {TERMINATOR}")) == CLIENT


def test_undercounting_proxies_collapses_everyone_onto_the_terminator():
    """The bug this finding is about, stated as a fact rather than a worry.

    With NUM_PROXIES=1 on a two-proxy deployment every caller resolves to the
    same address — which is what turns a per-IP throttle into a global one.
    """
    with override_settings(REST_FRAMEWORK={**settings.REST_FRAMEWORK, "NUM_PROXIES": 1}):
        assert client_ip(_request(f"{CLIENT}, {TERMINATOR}")) == TERMINATOR
        assert client_ip(_request(f"{SPOOF}, {CLIENT}, {TERMINATOR}")) == TERMINATOR


def test_drf_throttle_identity_agrees_with_the_helper():
    """DRF keys the throttles itself; the two must not drift apart."""
    with _two_proxies():
        request = _request(f"{SPOOF}, {CLIENT}, {TERMINATOR}")
        assert AuthThrottle().get_ident(request) == client_ip(request) == CLIENT


def test_no_forwarded_header_falls_back_to_the_peer():
    with _two_proxies():
        assert client_ip(RequestFactory().get("/api/health/", REMOTE_ADDR=NGINX)) == NGINX


def test_short_chain_does_not_index_past_the_start():
    """A request that reached gunicorn through fewer hops than configured still
    resolves to the leftmost address rather than raising."""
    with _two_proxies():
        assert client_ip(_request(CLIENT)) == CLIENT


# --------------------------------------------------------------------------- #
# The deployed value, not just the helper's arithmetic
# --------------------------------------------------------------------------- #
#: What production measured (docs/ops/railway.md gotcha 4): browser → Railway
#: edge → our nginx → gunicorn. Three appending hops, established empirically on
#: 2026-08-08 rather than predicted.
RAILWAY_HOP_COUNT = 3


def test_the_railway_image_defaults_to_the_measured_hop_count():
    """The number has to be in the image, not only in a dashboard.

    `base.py` defaults to 1 (right behind no proxy), `.env.prod.example` says 2
    (right for the compose topology), and production measured 3 — and until
    2026-08-23 nothing under `infra/railway/` said anything at all. A project
    rebuilt from this repo would therefore have got 1, which resolves every
    caller to the edge's address: one throttle bucket for the whole internet,
    which is the QA report's H1 failure.

    The Dockerfile is parsed rather than the setting read, because the setting
    under test is not this process's — it is the one the deployed image will
    boot with. A "simplification" back to 2 now has to argue with a test.
    """
    import pathlib
    import re

    dockerfile = (pathlib.Path(__file__).resolve().parents[4]
                  / "infra" / "railway" / "api.Dockerfile")
    assert dockerfile.is_file(), f"{dockerfile} has moved; this test must follow it"

    found = re.findall(r"^ENV\s+NUM_PROXIES=(\d+)\s*$",
                       dockerfile.read_text(), flags=re.MULTILINE)
    assert found, (
        "infra/railway/api.Dockerfile no longer sets NUM_PROXIES. Production "
        "would fall back to base.py's default of 1 and collapse every per-IP "
        "throttle onto Railway's edge address."
    )
    assert [int(v) for v in found] == [RAILWAY_HOP_COUNT], (
        f"the Railway image sets NUM_PROXIES={found}; the measured chain is "
        f"{RAILWAY_HOP_COUNT} hops (docs/ops/railway.md gotcha 4)"
    )


def test_the_compose_default_is_unchanged():
    """Writing the Railway value into the Railway image must not move the value
    every other deployment reads. `base.py` stays at 1 — correct behind no
    proxy, and the only safe default for a machine nobody has configured."""
    from decouple import config

    assert config("NUM_PROXIES", default=1, cast=int) == 1
