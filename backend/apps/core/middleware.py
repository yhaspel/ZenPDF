"""Response plumbing for the API (01-architecture.md §21.2, §9).

A guest session is minted lazily inside a write view. The raw token exists for
exactly one response and must reach the client on it. Doing that in middleware
rather than per-view means no write path can forget the header — and forgetting
it strands a session whose rows already exist.
"""
from __future__ import annotations

from .authentication import GUEST_TOKEN_HEADER


class ApiCacheControlMiddleware:
    """Stop the browser storing API answers it must not replay.

    Every `/api/` response is principal-specific: the same URL answers one way
    for a guest, another for the account that claimed that guest, another for
    nobody. None of them carried a `Cache-Control` header, so the decision fell
    to the browser's heuristics — and Chrome will happily store a `410 Gone`,
    keyed on the URL plus `Vary` (`Accept, origin`; the credential is not in
    it). One guest token going stale overnight was therefore enough to make
    `GET /api/config/` answer 410 *from cache* for every token minted
    afterwards: the app cleared each fresh session the moment it was created,
    and the visitor was left uploading files into a session nothing could read.
    The same trap applies to a cached `404` for a document that has since been
    re-created under a new session.

    So: an error is never stored. A success keeps whatever the view chose —
    `private, max-age=…` on a thumbnail pinned to a version is exactly right —
    and gets `private, no-store` when the view expressed no opinion.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if not request.path.startswith("/api/"):
            return response
        if response.status_code >= 400:
            response["Cache-Control"] = "no-store"
        elif not response.has_header("Cache-Control"):
            response["Cache-Control"] = "private, no-store"
        return response


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
