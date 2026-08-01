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


def test_a_trailing_dot_does_not_smuggle_an_internal_name():
    """`http://api./` resolves exactly like `http://api/` — the dot is a
    fully-qualified-name marker, not a different host."""
    with pytest.raises(InvalidParams, match="our own network"):
        check_url("http://api./")
