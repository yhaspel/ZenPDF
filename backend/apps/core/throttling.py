"""DRF throttles (01-architecture.md §16, §17b)."""
from rest_framework.throttling import (
    AnonRateThrottle,
    SimpleRateThrottle,
    UserRateThrottle,
)

from .authentication import ip_hash_of, raw_guest_token
from .models import hash_guest_token


class BurstAnonThrottle(AnonRateThrottle):
    """Callers with no principal at all (a page view before the first write)."""

    scope = "anon"

    def allow_request(self, request, view):
        # A guest has its own, stricter pair of throttles below; running the
        # anon throttle as well would double-count the same request.
        if getattr(request, "guest_session", None) is not None:
            return True
        return super().allow_request(request, view)


class SustainedUserThrottle(UserRateThrottle):
    scope = "user"


class _GuestScopedThrottle(SimpleRateThrottle):
    scope = "guest"

    def allow_request(self, request, view):
        if getattr(request, "guest_session", None) is None:
            return True
        return super().allow_request(request, view)


class GuestThrottle(_GuestScopedThrottle):
    """Keyed on the guest token itself."""

    def get_cache_key(self, request, view):
        token = raw_guest_token(request)
        if not token:
            return None
        return self.cache_format % {"scope": "guest_tok", "ident": hash_guest_token(token)}


class GuestIPThrottle(_GuestScopedThrottle):
    """Keyed on the salted IP hash.

    Both guest throttles run, so **the stricter of the two wins** — whichever
    bucket fills first rejects the request. Keying on the token alone would make
    clearing localStorage a free quota reset (§16); keying on IP alone would
    punish everyone behind one NAT.
    """

    def get_cache_key(self, request, view):
        ident = ip_hash_of(request)
        if not ident:
            return None
        return self.cache_format % {"scope": "guest_ip", "ident": ident}


class AuthThrottle(SimpleRateThrottle):
    """Per-IP throttle for auth endpoints (login/register/refresh) — 10/min.

    `get_ident` is only trustworthy because REST_FRAMEWORK["NUM_PROXIES"] is set;
    otherwise it keys on the whole client-supplied X-Forwarded-For chain.
    """

    scope = "auth"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}


class PublicSignThrottle(SimpleRateThrottle):
    """Per-IP throttle for public signing endpoints (phase 8) — 20/min."""

    scope = "public_sign"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}
