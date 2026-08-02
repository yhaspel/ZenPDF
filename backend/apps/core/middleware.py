"""Guest-token response plumbing (01-architecture.md §21.2).

A guest session is minted lazily inside a write view. The raw token exists for
exactly one response and must reach the client on it. Doing that in middleware
rather than per-view means no write path can forget the header — and forgetting
it strands a session whose rows already exist.
"""
from __future__ import annotations

from .authentication import GUEST_TOKEN_HEADER


class GuestTokenMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        raw = getattr(request, "_zen_new_guest_token", None)
        if raw:
            response[GUEST_TOKEN_HEADER] = raw
        return response


class AdminIPAllowlistMiddleware:
    """Source-IP gate in front of Django admin (§17).

    Two rules, both deliberate:

    * **An empty allowlist denies.** Forgetting to configure the gate must lock
      the door, not open it — the opposite default is how staff tooling ends up
      on the public internet.
    * **404, not 403.** "Wrong address" ends the conversation; "forbidden"
      confirms there is an admin here and invites somebody to find a way in.

    In DEBUG the gate is off, because the whole dev stack is one address and a
    developer locking themselves out of their own admin is pure friction.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        from django.conf import settings
        from django.http import Http404

        path = settings.ADMIN_URL_PATH.strip("/")
        if path and request.path.lstrip("/").startswith(path) and not settings.DEBUG:
            from .authentication import client_ip

            allowed = set(settings.ADMIN_IP_ALLOWLIST)
            # **Both** the socket peer and the proxy-derived client must be
            # allowed. `X-Forwarded-For` is client-supplied unless something
            # trustworthy overwrote it, and nginx proxies only `/api/` — so
            # admin is reached on gunicorn directly and a single header would
            # otherwise be the whole gate. Behind a proxy, list the proxy's
            # address as well as the operator's.
            peer = request.META.get("REMOTE_ADDR", "")
            if peer not in allowed or client_ip(request) not in allowed:
                raise Http404
        return self.get_response(request)
