"""Ownership — the ONLY place it may be expressed (01-architecture.md §21.2).

A *principal* is either a `users.User` (JWT) or a `core.GuestSession`
(`X-Guest-Token`). Every ownership expression in `documents`, `jobs` and `core`
routes through this module, and a grep test (`test_principals.py`) fails the
build if an ownership check anywhere else references `request.user`, `job.user`
or `owner=`.

That test covers all three spellings deliberately. The worker layer resolves
ownership through `job.user`, not `request.user`, and for a guest job `job.user`
is `None` — which fails two ways at once:

  * `Document.objects.create(owner=None)` also leaves `guest_session=None`,
    violating the exactly-one-of CheckConstraint → IntegrityError on every guest
    split/merge/extract/convert;
  * `filter(owner=None)` compiles to `owner_id IS NULL`, so a worker-side
    ownership re-check silently degenerates into "*any* guest's document with
    that id" — a cross-tenant read.

Both are routed through `principal_of(job)` / `owner_kwargs(...)` below.
"""
from __future__ import annotations

from typing import Any

from rest_framework.exceptions import NotFound

# `owner` on Document/Folder, `user` on Job/UsageCounter — same concept, two
# historical field names. One map keeps call sites from guessing.
_USER_FIELD = {
    "Document": "owner",
    "Folder": "owner",
    "Job": "user",
    "UsageCounter": "user",
}


def _model_of(qs_or_obj: Any):
    model = getattr(qs_or_obj, "model", None)
    return model if model is not None else type(qs_or_obj)


def _user_field(qs_or_obj: Any) -> str:
    return _USER_FIELD.get(_model_of(qs_or_obj).__name__, "owner")


def accepts_guests(qs_or_obj: Any) -> bool:
    """Whether this model can be owned by a GuestSession at all.

    `Folder`, `SavedSignature`, `SignRequest`, `Recipient`, `SignField` and
    `AuditEvent` are account-only (§21.2) and have no `guest_session` column, so
    filtering one by a guest principal is a `FieldError`, not an empty result.
    Answering "nothing" is both correct and what the caller means.
    """
    model = _model_of(qs_or_obj)
    return any(f.name == "guest_session" for f in model._meta.get_fields())


def is_guest(principal: Any) -> bool:
    """True for a GuestSession principal. Avoids importing core.models at call
    sites (and avoids isinstance checks against a circular import)."""
    return type(principal).__name__ == "GuestSession"


def is_account(principal: Any) -> bool:
    return principal is not None and not is_guest(principal)


def owner_kwargs(principal: Any) -> dict[str, Any]:
    """Kwargs that assign ownership when *creating* a row.

    Returns exactly one non-null key, so the exactly-one-of CheckConstraint
    holds by construction. `model` picks the right field name for Job.
    """
    if principal is None:
        raise ValueError("owner_kwargs() requires a principal; got None.")
    if is_guest(principal):
        return {"guest_session": principal}
    return {"owner": principal}


def job_owner_kwargs(principal: Any) -> dict[str, Any]:
    """`owner_kwargs` for models whose user field is named `user` (Job,
    UsageCounter)."""
    if principal is None:
        raise ValueError("job_owner_kwargs() requires a principal; got None.")
    if is_guest(principal):
        return {"guest_session": principal}
    return {"user": principal}


def owned_by(qs, principal: Any):
    """Filter `qs` to rows owned by `principal`.

    A `None` principal matches nothing — never "rows whose owner is NULL",
    which would be every guest's rows.
    """
    if principal is None:
        return qs.none()
    field = _user_field(qs)
    if is_guest(principal):
        # An account-only model can never be guest-owned — match nothing rather
        # than raising FieldError on a column that does not exist.
        return qs.filter(guest_session=principal) if accepts_guests(qs) else qs.none()
    return qs.filter(**{field: principal})


def owns(obj: Any, principal: Any) -> bool:
    if obj is None or principal is None:
        return False
    field = _user_field(obj)
    if is_guest(principal):
        if not accepts_guests(obj):
            return False
        return getattr(obj, "guest_session_id", None) == principal.pk
    # An account never owns a guest row, even if the id types happened to match.
    if getattr(obj, "guest_session_id", None) is not None:
        return False
    return getattr(obj, f"{field}_id", None) == principal.pk


def assert_owned(obj: Any, principal: Any) -> Any:
    """Return `obj` if `principal` owns it, else raise NotFound.

    404, never 403: a 403 would confirm the object exists, leaking the id space
    across principals (§21.2).
    """
    if not owns(obj, principal):
        raise NotFound("Not found.")
    return obj


def principal_of(job: Any) -> Any:
    """The principal that owns a Job — never read `job.user` directly (§21.2)."""
    return job.guest_session or job.user


def created_by_user(job: Any) -> Any:
    """The `User` to stamp on a DocumentVersion's `created_by` audit field.

    Not an ownership expression — `created_by` is provenance, and §9 has it
    nullable precisely so a guest version can say "nobody in particular". It
    lives here anyway because §21.2 is literal: `job.user` is read in exactly
    one module, so the grep gate stays a clean signal instead of needing an
    allowlist entry that would also hide the worker trap.
    """
    return job.user


def principal_of_document(document: Any) -> Any:
    """The principal that owns a Document."""
    return document.guest_session or document.owner


def label(principal: Any) -> str:
    """'guest' | 'user' | 'none' — for serializers and log lines."""
    if principal is None:
        return "none"
    return "guest" if is_guest(principal) else "user"
