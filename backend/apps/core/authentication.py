"""Principal resolution (01-architecture.md §6, §21.2).

Exactly one principal per request: a `User` via JWT, else a `GuestSession` via
`X-Guest-Token`, else none. `request.user` stays a real User (or
`AnonymousUser`) so Django/DRF internals keep working; the guest principal
rides on `request.guest_session`, and views read `request.principal`.
"""
from __future__ import annotations

from django.conf import settings
from rest_framework.authentication import BaseAuthentication
from rest_framework_simplejwt.authentication import JWTAuthentication

from . import logging as zen_logging
from .exceptions import GuestExpired
from .models import GuestSession, hash_ip

GUEST_TOKEN_HEADER = "X-Guest-Token"
_META_KEY = "HTTP_X_GUEST_TOKEN"


def client_ip(request) -> str:
    """The last X-Forwarded-For hop (the one our own proxy appended), else
    REMOTE_ADDR. Trusting the whole client-supplied chain would make the IP leg
    of the guest throttle key free to spoof (§16)."""
    xff = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if xff:
        hops = [h.strip() for h in xff.split(",") if h.strip()]
        num_proxies = settings.REST_FRAMEWORK.get("NUM_PROXIES", 1) or 0
        if hops:
            idx = max(0, len(hops) - int(num_proxies))
            return hops[idx] if idx < len(hops) else hops[-1]
    return request.META.get("REMOTE_ADDR", "") or ""


def raw_guest_token(request) -> str:
    return request.META.get(_META_KEY, "") or ""


class PrincipalAuthentication(BaseAuthentication):
    """JWT first, then `X-Guest-Token`, then anonymous-with-no-principal."""

    def __init__(self):
        self._jwt = JWTAuthentication()

    def authenticate(self, request):
        jwt_result = self._jwt.authenticate(request)
        if jwt_result is not None:
            user, validated = jwt_result
            request.principal = user
            request.guest_session = None
            # Every log line for the rest of this request says who it was —
            # `user:<uuid>`, never the address (§10.4).
            zen_logging.bind(principal=f"user:{user.pk}")
            return user, validated

        token = raw_guest_token(request)
        if not token:
            request.principal = None
            request.guest_session = None
            return None

        session = GuestSession.resolve(token)
        if session is None:
            # An unknown token is indistinguishable from an expired one that has
            # already been purged, and "your session ended" is the truthful,
            # actionable message for both (§21.4). Never 401 → it would send the
            # SPA into the login redirect this phase exists to remove.
            raise GuestExpired()
        if session.is_expired or session.is_claimed:
            raise GuestExpired()

        session.touch()
        request.principal = session
        request.guest_session = session
        zen_logging.bind(principal=f"guest:{session.pk}")
        return None  # no Django user — DRF leaves request.user as AnonymousUser

    def authenticate_header(self, request):
        return 'Bearer realm="api"'


def mint_guest_session(request) -> tuple[GuestSession, str]:
    """Lazily mint on a first write and bind it to this request (§21.2).

    The caller is responsible for putting the raw token on the response via
    `attach_guest_token` — it is returned exactly once.
    """
    session, raw = GuestSession.mint(
        ip=client_ip(request),
        user_agent=request.META.get("HTTP_USER_AGENT", ""),
    )
    request.principal = session
    request.guest_session = session
    # Stamp the *underlying* HttpRequest as well: middleware sees that object,
    # and DRF's Request wrapper does not proxy attribute writes down to it.
    underlying = getattr(request, "_request", request)
    underlying._zen_new_guest_token = raw
    request._zen_new_guest_token = raw
    return session, raw


def require_principal(request, *, mint: bool = False):
    """The principal for this request, minting one on a write if asked.

    `mint=True` is passed by write endpoints only: a page view must never
    create a row (§21.2).
    """
    principal = getattr(request, "principal", None)
    if principal is not None:
        return principal
    if mint and settings.GUEST_ACCESS_ENABLED:
        session, _ = mint_guest_session(request)
        return session
    return None


def attach_guest_token(request, response):
    """Echo a freshly minted raw token in the `X-Guest-Token` response header."""
    raw = getattr(request, "_zen_new_guest_token", None)
    if raw:
        response[GUEST_TOKEN_HEADER] = raw
    return response


def ip_hash_of(request) -> str:
    return hash_ip(client_ip(request))
