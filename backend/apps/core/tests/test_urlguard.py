"""The URL→PDF fetch guard (phase-06 acceptance criterion 4; §17).

"URL→PDF refuses `http://169.254.169.254/`, `http://localhost:8000/`,
`file:///etc/passwd` with clear errors (tests prove)."
"""
from unittest import mock

import pytest

from apps.core.urlguard import check_url
from apps.pdf_engine.exceptions import InvalidParams


@pytest.mark.parametrize("url", [
    # The three the criterion names, verbatim.
    "http://169.254.169.254/",
    "http://localhost:8000/",
    "file:///etc/passwd",
    # …and the rest of the private space.
    "http://127.0.0.1/",
    "http://127.1/",
    "http://10.0.0.5/admin",
    "http://172.16.4.4/",
    "http://192.168.1.1/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://0.0.0.0/",
    # Our own services by name — inside the compose network.
    "http://api:8000/api/documents/",
    "http://db:5432/",
    "http://storage:8333/",
    "http://gotenberg:3000/forms/chromium/convert/url",
    # Cloud metadata by name as well as by address.
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://anything.internal/",
    # Schemes that are not the web.
    "gopher://example.com/",
    "ftp://example.com/x",
    "data:text/html,<h1>hi</h1>",
    "javascript:alert(1)",
    "",
])
def test_the_guard_refuses(url):
    with pytest.raises(InvalidParams):
        check_url(url)


@pytest.mark.parametrize("url,message", [
    ("file:///etc/passwd", "http and https"),
    ("http://169.254.169.254/", "private network"),
    ("http://api:8000/", "our own network"),
])
def test_the_refusal_says_why(url, message):
    """A 400 with no explanation is useless: most of these are typos and
    intranet links, not attacks."""
    with pytest.raises(InvalidParams) as exc:
        check_url(url)
    assert message in str(exc.value)


def test_a_public_address_is_allowed():
    with mock.patch("apps.core.urlguard._resolve",
                    return_value=[__import__("ipaddress").ip_address("93.184.216.34")]):
        assert check_url("https://example.com/report") == "https://example.com/report"


def test_a_name_that_resolves_into_the_private_space_is_refused():
    """The interesting case: the *name* looks public. Nothing about
    `pdf.example.com` says 10.0.0.7 until it is resolved."""
    with mock.patch("apps.core.urlguard._resolve",
                    return_value=[__import__("ipaddress").ip_address("10.0.0.7")]):
        with pytest.raises(InvalidParams, match="private network"):
            check_url("https://pdf.example.com/")


def test_one_private_answer_out_of_several_is_enough_to_refuse():
    """A round-robin with one private answer is the same attack with an extra
    step: whichever address Chromium picks has to be safe."""
    import ipaddress

    with mock.patch("apps.core.urlguard._resolve", return_value=[
        ipaddress.ip_address("93.184.216.34"),
        ipaddress.ip_address("169.254.169.254"),
    ]):
        with pytest.raises(InvalidParams):
            check_url("https://split.example.com/")


def test_a_name_that_does_not_resolve_is_refused_by_name():
    import socket

    with mock.patch("apps.core.urlguard.socket.getaddrinfo",
                    side_effect=socket.gaierror("nope")):
        with pytest.raises(InvalidParams, match="could not be resolved"):
            check_url("https://no-such-host.example/")


def test_gotenberg_denies_what_layer_one_denies():
    """Layer 2 must actually be configured (§17, phase-06).

    Layer 1 checks the URL a user typed. It cannot see a redirect, and it cannot
    see a name that resolves publicly when we check it and privately when
    Chromium connects a moment later. Gotenberg's deny-list is what covers both,
    because it is evaluated on *every* navigation — so its absence, or a hole in
    it, is something no test of `check_url` would ever notice.

    Compose passes this exact setting to the container.
    """
    import re

    from django.conf import settings

    pattern = re.compile(settings.GOTENBERG_DENY_LIST)
    for url in [
        "http://169.254.169.254/latest/meta-data/",
        "http://localhost:8000/",
        "http://127.0.0.1/",
        "http://127.1/",
        "http://10.0.0.5/",
        "http://172.20.1.1/",
        "http://192.168.0.1/",
        "http://api:8000/api/documents/",
        "http://storage:8333/",
        "http://metadata.google.internal/",
        "http://anything.internal/",
        "file:///etc/passwd",
        # The forms a browser accepts and a naive pattern misses. Every one of
        # these was reachable when this test was first written: the container's
        # own log showed Chromium dialling redis and db through the trailing-dot
        # spelling, which layer 1 strips and layer 2 did not.
        "http://redis.:6379/",
        "http://db.:5432/",
        "http://127.0.0.1./",
        "http://169.254.169.254./",
        "http://2130706433/",            # decimal
        "http://0177.0.0.1/",            # octal
        "http://0x7f000001/",            # hex
        "http://[::ffff:127.0.0.1]/",    # IPv4-mapped IPv6
        "http://[0:0:0:0:0:ffff:127.0.0.1]/",
        "http://[fe80::1]/",
        "http://user@api:8000/",         # userinfo before the host
        # The four ranges layer 1 blocks and layer 2 did not (M5). Each is a
        # real route into somewhere private, and a redirect is all it takes.
        "http://100.64.0.1/",            # RFC 6598 CGNAT, low end
        "http://100.127.255.254/",       # …and high end
        "http://198.18.0.1/",            # RFC 2544 benchmarking
        "http://198.19.255.254/",
        "http://192.88.99.1/",           # RFC 7526 6to4 relay anycast
        # RFC 6052 NAT64: this one *is* 169.254.169.254, spelled for a network
        # where v6 is the only transport.
        "http://[64:ff9b::a9fe:a9fe]/latest/meta-data/",
        "http://[64:ff9b::]/",
    ]:
        assert pattern.match(url), f"gotenberg would still fetch {url}"

    # …and it must not deny the ordinary web, or the tool does nothing at all.
    # …and it must not deny the ordinary web. A service name is a whole host,
    # not a prefix: `apiexample.com` and `dbz.com` are somebody's real site.
    for url in [
        "https://example.com/report",
        "http://news.example.co.uk/a/b",
        "https://apiexample.com/",
        "https://dbz.com/",
        "https://web.dev/",
        "https://storage.googleapis.com/x",
        "https://8.8.8.8/",
        # The neighbours of the four ranges added above. A range written one
        # digit too wide is a tool that refuses somebody's real website.
        "https://100.63.255.254/",
        "https://100.128.0.1/",
        "https://100.6.4.1/",
        "https://198.17.255.254/",
        "https://198.20.0.1/",
        "https://192.88.98.1/",
        "https://192.89.99.1/",
    ]:
        assert not pattern.match(url), f"gotenberg would refuse {url}"


def test_the_running_deny_list_matches_the_one_shipped_in_the_code():
    """The pattern is written out four times, and the copies must not drift.

    It is repeated on purpose: `${GOTENBERG_DENY_LIST}` with no fallback would
    pass an *empty* deny-list on any machine whose `.env` predates the setting,
    which turns layer 2 off silently on exactly the boxes that have been running
    longest. The price is four chances to update three of them.

    This asserts the dangerous half from inside the container: that the value
    actually in force — the environment's, which is also what compose hands
    Gotenberg — has not fallen behind the literal in `settings/base.py`. The
    `infra/` copies are compared to each other by `infra/test.sh`, which is the
    only place in the gate that can see them (the api container mounts
    `backend/` and nothing else).
    """
    import pathlib

    from django.conf import settings

    source = (pathlib.Path(settings.BASE_DIR)
              / "config" / "settings" / "base.py").read_text()
    # `$$` is an escaped `$` in compose and in the env files it feeds.
    running = settings.GOTENBERG_DENY_LIST.replace("$$", "$")
    assert running in source, (
        "the deny-list in force has drifted from the default in "
        "config/settings/base.py — see infra/.env and infra/docker-compose*.yml")


def test_the_deny_list_survives_gotenbergs_flag_parser():
    """Its parser splits the flag value on commas, which would truncate the
    pattern mid-expression and leave a regex that still compiles."""
    from django.conf import settings

    assert "," not in settings.GOTENBERG_DENY_LIST


def test_a_trailing_dot_does_not_smuggle_an_internal_name():
    """`http://api./` resolves exactly like `http://api/` — the dot is a
    fully-qualified-name marker, not a different host."""
    with pytest.raises(InvalidParams, match="our own network"):
        check_url("http://api./")


def test_carrier_grade_nat_and_the_deprecated_relay_are_refused():
    """Found by testing rather than reasoning, which is why they are written
    out: `100.64.0.0/10` is neither `is_private` nor `is_global`, so the six
    flags all missed it — and `192.88.99.0/24` *is* `is_global`, so even
    adding `not ip.is_global` would not have closed it."""
    for url in ("http://100.64.1.1/", "http://192.88.99.1/",
                "http://198.18.0.1/"):
        with pytest.raises(InvalidParams):
            check_url(url)


def test_an_ordinary_public_address_still_passes():
    """The guard is only useful if it is not simply a wall."""
    assert check_url("https://example.com/report.html").startswith("https://")
