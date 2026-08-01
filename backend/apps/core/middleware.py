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
