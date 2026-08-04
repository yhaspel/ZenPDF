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
