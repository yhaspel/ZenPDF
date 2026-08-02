"""DRF throttles (01-architecture.md §16, §17b)."""
import hashlib

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


class PublicSignTokenThrottle(SimpleRateThrottle):
    """Per-*token* daily cap for the ceremony — §9B: 200/day.

    The IP throttle above stops a flood from one machine; this one stops a
    single leaked link being replayed all day from everywhere. 200 is far above
    what signing a document honestly takes (open, read, place a few fields,
    submit) and far below what scripted abuse of a public URL looks like.
    """

    scope = "public_sign_token"

    def get_cache_key(self, request, view):
        token = (view.kwargs or {}).get("token", "")
        if not token:
            return None
        digest = hashlib.sha256(token.encode()).hexdigest()
        return self.cache_format % {"scope": self.scope, "ident": digest}


class UploadThrottle(SimpleRateThrottle):
    """Per-*account* upload rate (§9B: 20/hour).

    Keyed on the user, not the IP: an office behind one address is many people,
    and a guest is already covered by `GuestThrottle` + `GuestIPThrottle`. An
    anonymous caller returns `None`, which means "this throttle has no opinion"
    — not "allow anything", because the guest throttles still run.
    """

    scope = "upload"

    def allow_request(self, request, view):
        # DRF runs `get_throttles()` for *every* method, so without this the
        # 20/hour budget would be spent by the dashboard listing documents —
        # twenty reads is a few minutes of ordinary use.
        if request.method not in ("POST", "PUT", "PATCH"):
            return True
        return super().allow_request(request, view)

    def get_cache_key(self, request, view):
        user = getattr(request, "user", None)
        if user is None or not user.is_authenticated:
            return None
        return self.cache_format % {"scope": self.scope, "ident": str(user.pk)}


class VerifyThrottle(SimpleRateThrottle):
    """Per-IP burst rate for `/api/verify/` (§9B: 10/min).

    It has no principal by design — the person checking a document they were
    sent is a stranger — so the address is all there is to key on. Pair it with
    `VerifyHourlyThrottle`: this endpoint takes an arbitrary PDF from a stranger
    and runs signature verification on it, which is the most expensive
    anonymous work in the product, so a burst limit alone is not a ceiling.
    """

    scope = "verify"

    def get_cache_key(self, request, view):
        return self.cache_format % {
            "scope": self.scope, "ident": self.get_ident(request),
        }


class VerifyHourlyThrottle(VerifyThrottle):
    """The hourly ceiling behind the burst limit — 60/hour/IP."""

    scope = "verify_hour"
