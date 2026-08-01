"""Permissions over the principal model (01-architecture.md §6, §21.3).

`IsPrincipal` is the project default: a User *or* a GuestSession satisfies it,
and so does an unauthenticated caller on a read — a guest token is minted lazily
on the first write, not on a page view, so demanding one up front would
reinstate the wall this phase removes.

`IsAccount` marks the (short, written-down) list of account-only endpoints and
answers 403 `account_required`, which the UI renders as a signup prompt.
"""
from __future__ import annotations

from django.conf import settings
from rest_framework.permissions import BasePermission

from .exceptions import AccountRequired
from .principals import is_account


class IsPrincipal(BasePermission):
    """Always true while guest access is on; falls back to account-only when
    `GUEST_ACCESS_ENABLED=false` so the flag genuinely closes the door."""

    def has_permission(self, request, view) -> bool:
        if settings.GUEST_ACCESS_ENABLED:
            return True
        return is_account(getattr(request, "principal", None))


class IsAccount(BasePermission):
    """Account-only (§21.3). Raises so the body carries `account_required`
    rather than DRF's generic `permission_denied`."""

    message = "Create a free account to use this feature."

    def has_permission(self, request, view) -> bool:
        if is_account(getattr(request, "principal", None)):
            return True
        raise AccountRequired(getattr(view, "account_required_message", None) or self.message)
