"""DRF throttles (01-architecture.md §16, §17b)."""
import hashlib

from rest_framework.throttling import (
    AnonRateThrottle,
    SimpleRateThrottle,
    UserRateThrottle,
)

from .authentication import ip_hash_of, raw_guest_token
from .models import hash_guest_token


class AlwaysSaysWhenMixin:
    """A refusal that always says when to try again.

    DRF's `SimpleRateThrottle.wait()` returns **None** when
    `num_requests - len(history) + 1 <= 0`, and a `None` travels a long way: it
    strips the `Retry-After` header, drops the "Expected available in N
    seconds" clause from `Throttled`'s own message, and leaves
    `exceptions.py` with no `wait` to put in `details.retry_after_seconds`.
    The client is then told to slow down and not told for how long — and the
    workspace's throttled screen, whose whole point is a disabled "Try again"
    with a countdown on it, degrades to a button that can only earn a second
    refusal.

    **When this is reachable, measured rather than assumed.** Not by hammering:
    `throttle_success` only appends while `len(history) < num_requests`, so
    under a stable rate the history never outgrows the allowance and `wait()`
    always answers. It needs `len(history) > num_requests`, which means the
    rate was **lowered** while entries recorded under the higher one were still
    in the cache — an operator turning `THROTTLE_GUEST` down under load, or a
    deploy that tightens §16. Reproduced deterministically on 2026-08-25 by
    filling a bucket at `3/min`, restarting the api at `1/min` and asking
    again: `{"code":"throttled","message":"Request was throttled.","details":{}}`
    with no `Retry-After`, on every request until the window rolled over.

    The answer is the moment the history drops back below the allowance. The
    entries are newest-first, so `num_requests - 1` is the newest one that
    still has to expire before there is room; DRF's own formula is this same
    quantity in the case where exactly one entry has to go.
    """

    def wait(self):
        wait = super().wait()
        if wait is not None:
            return wait
        index = self.num_requests - 1
        if index < 0 or index >= len(self.history):
            # A rate of `0/…` allows nothing, and there is no honest moment to
            # name; the window length is the least misleading answer.
            return self.duration
        return max(0.0, self.history[index] + self.duration - self.now)


class BurstAnonThrottle(AlwaysSaysWhenMixin, AnonRateThrottle):
    """Callers with no principal at all (a page view before the first write)."""

    scope = "anon"

    def allow_request(self, request, view):
        # A guest has its own, stricter pair of throttles below; running the
        # anon throttle as well would double-count the same request.
        if getattr(request, "guest_session", None) is not None:
            return True
        return super().allow_request(request, view)


class SustainedUserThrottle(AlwaysSaysWhenMixin, UserRateThrottle):
    scope = "user"


class _GuestScopedThrottle(AlwaysSaysWhenMixin, SimpleRateThrottle):
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


class AuthThrottle(AlwaysSaysWhenMixin, SimpleRateThrottle):
    """Per-IP throttle for auth endpoints (login/register/refresh) — 10/min.

    `get_ident` is only trustworthy because REST_FRAMEWORK["NUM_PROXIES"] is set;
    otherwise it keys on the whole client-supplied X-Forwarded-For chain.
    """

    scope = "auth"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}


class PublicSignThrottle(AlwaysSaysWhenMixin, SimpleRateThrottle):
    """Per-IP throttle for public signing endpoints (phase 8) — 20/min."""

    scope = "public_sign"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}


class PublicSignTokenThrottle(AlwaysSaysWhenMixin, SimpleRateThrottle):
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


class UploadThrottle(AlwaysSaysWhenMixin, SimpleRateThrottle):
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


class VerifyThrottle(AlwaysSaysWhenMixin, SimpleRateThrottle):
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
