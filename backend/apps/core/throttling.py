"""DRF throttles (01-architecture.md §16)."""
from rest_framework.throttling import (
    AnonRateThrottle,
    SimpleRateThrottle,
    UserRateThrottle,
)


class BurstAnonThrottle(AnonRateThrottle):
    scope = "anon"


class SustainedUserThrottle(UserRateThrottle):
    scope = "user"


class AuthThrottle(SimpleRateThrottle):
    """Per-IP throttle for auth endpoints (login/register/refresh) — 10/min."""

    scope = "auth"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}


class PublicSignThrottle(SimpleRateThrottle):
    """Per-IP throttle for public signing endpoints (phase 8) — 20/min."""

    scope = "public_sign"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}
