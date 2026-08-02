"""URL→PDF fetch guard (01-architecture.md §17; phase-06 "Conversions IN").

Layer 1 of the three the phase specifies. A user hands us a URL and we ask a
headless browser inside our own network to fetch it — which is server-side
request forgery with a UI, unless every hop is checked:

1. **here** — scheme allowlist, DNS resolution, and rejection of every private,
   loopback, link-local and cloud-metadata range;
2. Gotenberg's own deny-list, which is evaluated on *every navigation*, so a
   redirect into the private space is refused even though we only checked the
   first URL;
3. size and time caps on the conversion itself.

The residual risk is DNS rebinding — a name that resolves to a public address
when we check it and to a private one when Chromium connects. Layer 2 is what
covers that, because the deny-list is applied per navigation inside the browser
rather than once, up front, out here. It is documented as accepted in §17.
"""
from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlsplit

from apps.pdf_engine.exceptions import InvalidParams

ALLOWED_SCHEMES = frozenset({"http", "https"})

# Hostnames of our own services. A URL naming one of these never leaves the
# compose network, so it is refused before DNS is even consulted — otherwise
# `http://api:8000/api/documents/…` is a self-request with our own credentials
# absent but our own network position present.
INTERNAL_HOSTS = frozenset({
    "api", "web", "db", "redis", "storage", "mailpit", "gotenberg",
    "worker-default", "worker-heavy", "worker-render", "beat",
    "localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback",
})

# Cloud metadata endpoints, which are the point of most SSRF attempts: they are
# plain HTTP, unauthenticated, and hand out credentials.
#: `ipaddress._BaseAddress` — what this used to be annotated with — has none of
#: the six attributes the deny-list below reads, so mypy validated *none* of
#: them. With the real union, deleting `or ip.is_private` is a type error.
IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address

METADATA_HOSTS = frozenset({
    "169.254.169.254",              # AWS / Azure / DigitalOcean / OpenStack
    "metadata.google.internal",     # GCP
    "metadata.goog",
    "100.100.200.200",              # Alibaba
})


#: Ranges that are neither `is_private` nor usefully covered by the other
#: predicates, and that a hosting provider may well route internally.
#: `100.64.0.0/10` is carrier-grade NAT — `is_private` is False and
#: `is_global` is False, so the six flags below all miss it. `192.88.99.0/24`
#: is the deprecated 6to4 relay anycast, where `is_global` is *True*, so even
#: adding `not ip.is_global` would not have closed it. Written out rather than
#: derived, because both were found by somebody testing rather than reasoning.
EXTRA_FORBIDDEN_NETWORKS = (
    ipaddress.ip_network("100.64.0.0/10"),      # RFC 6598 carrier-grade NAT
    ipaddress.ip_network("192.88.99.0/24"),     # RFC 7526, deprecated 6to4
    ipaddress.ip_network("198.18.0.0/15"),      # RFC 2544 benchmarking
    ipaddress.ip_network("64:ff9b::/96"),       # RFC 6052 NAT64
)


def _is_forbidden_ip(ip: IPAddress) -> bool:
    """Everything that is not a public, routable address."""
    return bool(
        ip.is_private            # 10/8, 172.16/12, 192.168/16, fd00::/8, ::1, 127/8
        or ip.is_loopback
        or ip.is_link_local      # 169.254/16, fe80::/10
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
        or getattr(ip, "is_site_local", False)
        or any(ip in network for network in EXTRA_FORBIDDEN_NETWORKS
               if ip.version == network.version)
    )


def _resolve(host: str) -> list[IPAddress]:
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise InvalidParams(f"That address could not be resolved: {host}") from exc
    addresses = []
    for info in infos:
        raw = info[4][0]
        try:
            addresses.append(ipaddress.ip_address(raw))
        except ValueError:
            continue
    if not addresses:
        raise InvalidParams(f"That address could not be resolved: {host}")
    return addresses


def check_url(url: str) -> str:
    """Return the URL if it is safe to fetch, else raise `InvalidParams`.

    Every rejection says what was wrong in words the person who typed the URL
    can act on — "we cannot open addresses inside a private network" rather than
    a bare 400, because the honest majority of these are typos and intranet
    links, not attacks.
    """
    text = (url or "").strip()
    if not text:
        raise InvalidParams("Enter a web address to convert.")

    parts = urlsplit(text)
    scheme = parts.scheme.lower()
    if scheme not in ALLOWED_SCHEMES:
        raise InvalidParams(
            f"Only http and https addresses can be converted, not '{scheme or text[:20]}'."
        )
    host = (parts.hostname or "").lower().rstrip(".")
    if not host:
        raise InvalidParams("That web address has no host name.")

    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None

    # By *name*: our own services, and the metadata endpoints that have one.
    # An address literal falls through to the range check below, which gives it
    # the more accurate "resolves inside a private network".
    if literal is None and (host in INTERNAL_HOSTS or host in METADATA_HOSTS
                            or host.endswith(".internal")):
        raise InvalidParams(
            "That address points inside our own network, so it cannot be converted."
        )

    # A literal IP is checked directly; a name is resolved and *every* answer
    # has to be public, because a round-robin with one private answer is the
    # same attack with an extra step.
    addresses = [literal] if literal is not None else _resolve(host)
    for ip in addresses:
        if _is_forbidden_ip(ip) or str(ip) in METADATA_HOSTS:
            raise InvalidParams(
                "That address resolves inside a private network, so it cannot be converted."
            )
    return text
