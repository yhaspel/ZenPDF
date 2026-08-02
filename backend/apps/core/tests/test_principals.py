"""The ownership choke point, and the grep gate that keeps it one (§21.2).

Phase-2B acceptance: *no ownership check outside `apps/core/principals.py`
references `request.user`* — proved by test, not by review. The refactor touches
nearly every queryset in `documents`/`jobs`/`core`, and a missed call site is a
silent cross-tenant leak: exactly the class of bug review misses and a
mechanical test catches.
"""
from __future__ import annotations

import io
import re
import token as token_mod
import tokenize
from pathlib import Path

import pytest

from apps.core.models import GuestSession
from apps.core.principals import (
    assert_owned,
    is_account,
    is_guest,
    job_owner_kwargs,
    owned_by,
    owner_kwargs,
    owns,
    principal_of,
)

BACKEND = Path(__file__).resolve().parents[3]
APPS = BACKEND / "apps"
CHOKE_POINT = APPS / "core" / "principals.py"

# All three spellings, deliberately (§21.2):
#   request.user — the API layer
#   job.user     — the WORKER layer, where ownership actually flows. A test
#                  scoped to `request.user` alone passes while the two guest
#                  bugs in documents/tasks.py are live.
#   owner=       — direct assignment/filtering that bypasses owner_kwargs(),
#                  which is how `owner=None` (→ `owner_id IS NULL`, i.e. any
#                  guest's rows) gets written in the first place.
PATTERNS = {
    "request.user": re.compile(r"\brequest\.user\b"),
    "job.user": re.compile(r"\bjob\.user\b"),
    "owner=": re.compile(r"\bowner\s*="),
    # DRF serializers spell it `self.context["request"].user`, which none of the
    # above catch once string literals are blanked out. Same expression, same
    # risk — matched on the blanked line, where the subscript is whitespace.
    "context-request.user": re.compile(r"context\[[^\]]*\]\.user\b"),
}

# Files that may legitimately mention these. Each needs a written reason, and
# `test_allowlist_has_no_dead_entries` deletes the ones that stop being true —
# an exemption nothing matches is a hole the next call site slips through.
ALLOWED: dict[str, set[str]] = {
    # The choke point itself — reading `job.user` here is the whole point.
    "core/principals.py": {"job.user"},
    # A model *definition* declares the field the pattern matches.
    "documents/models.py": {"owner="},
    # Folders are account-only (§21.3), so `owner` really is the whole story:
    # the serializer validates a parent/target folder against the account.
    "documents/serializers.py": {"owner=", "context-request.user"},
    # Claim reparents rows by definition — writing `owner` is its job (§21.5).
    "core/claim.py": {"owner="},
    # `MeView` / `_claim_inline` operate on the authenticated account itself.
    # That is identity, not ownership.
    "users/views.py": {"request.user"},
    # The claim endpoint passes `request.user` to claim_session() as the *target*
    # account; it filters nothing by it.
    "core/views.py": {"request.user"},
    # `pikepdf.Encryption(owner=…)` is a PDF *owner password* — the credential
    # that lifts a document's restrictions. Nothing to do with row ownership,
    # and the engine has no database access at all (phase-07).
    "pdf_engine/engine/security.py": {"owner="},
    # Saved signatures and sign requests are **account-only** (§21.3, and
    # phase-08 states it normatively): sending email in somebody's name needs
    # an identified sender. `request.user` there *is* the principal, and the
    # rows have no guest column to confuse it with. The one lookup that crosses
    # into guest-capable data — the document being sent — goes through
    # `owned_by()` like everything else (phase-08).
    "esign/views.py": {"request.user", "owner="},
    # `SignRequest.owner` is a plain FK to an account — a sign request cannot
    # belong to a guest at all, so there is no `owner_id IS NULL` to fall into.
    # These read it to address the sender, not to decide who owns a row.
    "esign/emails.py": {"owner="},
    "esign/certificate.py": {"owner="},
    # Model definitions declare the fields the patterns match.
    "esign/models.py": {"owner="},
}


_IGNORED_TOKENS = {
    token_mod.COMMENT,
    token_mod.STRING,
    getattr(token_mod, "FSTRING_MIDDLE", -1),
}


def _code_lines(source: str) -> list[str]:
    """The source with comments and string literals blanked out, positions kept.

    An ownership check is *code*. Matching raw text makes the gate fire on its
    own explanatory prose — noise that gets silenced with allowlist entries,
    which is precisely how a real violation would later slip through.
    """
    lines = source.splitlines()
    blanked = list(lines)
    try:
        tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return lines  # unparseable: fall back to raw text rather than pass blindly
    for tok in tokens:
        if tok.type not in _IGNORED_TOKENS:
            continue
        (srow, scol), (erow, ecol) = tok.start, tok.end
        for row in range(srow, erow + 1):
            idx = row - 1
            if idx >= len(blanked):
                continue
            line = blanked[idx]
            start = scol if row == srow else 0
            end = ecol if row == erow else len(line)
            blanked[idx] = line[:start] + " " * max(0, end - start) + line[end:]
    return blanked


def _source_files():
    for path in sorted(APPS.rglob("*.py")):
        rel = path.relative_to(APPS).as_posix()
        if "/migrations/" in f"/{rel}" or "/tests/" in f"/{rel}":
            continue
        yield rel, path


def test_no_ownership_check_outside_principals_module():
    """Fails the build on any ownership expression outside the choke point."""
    violations: list[str] = []
    for rel, path in _source_files():
        allowed = ALLOWED.get(rel, set())
        source = path.read_text(encoding="utf-8")
        raw = source.splitlines()
        for lineno, line in enumerate(_code_lines(source), start=1):
            for name, pattern in PATTERNS.items():
                if name in allowed:
                    continue
                if pattern.search(line):
                    violations.append(f"{rel}:{lineno}: {name} → {raw[lineno - 1].strip()}")
    assert not violations, (
        "Ownership must be expressed only in apps/core/principals.py (§21.2).\n"
        + "\n".join(violations)
    )


def test_gate_ignores_prose_but_not_code():
    """The blanking must not become a hole: code still matches."""
    prose = '"""A docstring mentioning request.user and owner=x."""\nx = 1  # job.user\n'
    assert not any(
        p.search(line) for line in _code_lines(prose) for p in PATTERNS.values()
    )
    code = "qs.filter(owner=job.user)\n"
    assert PATTERNS["owner="].search(_code_lines(code)[0])
    assert PATTERNS["job.user"].search(_code_lines(code)[0])


def test_grep_gate_would_catch_the_worker_trap():
    """Guard on the guard.

    The pattern set must keep covering `job.user` and `owner=`, not just
    `request.user` — the two guest bugs the plan calls out live entirely in the
    worker layer and would sail past a request-scoped gate.
    """
    assert {"request.user", "job.user", "owner="} <= set(PATTERNS)
    assert PATTERNS["job.user"].search("src = Document.objects.get(id=x, owner=job.user)")
    assert PATTERNS["owner="].search("_create_document_from_bytes(owner=job.user)")


def test_choke_point_is_the_only_module_that_may_do_this():
    assert CHOKE_POINT.exists()
    assert "core/principals.py" in ALLOWED


def test_allowlist_has_no_dead_entries():
    """Every exemption must still be load-bearing.

    An exemption that no longer matches anything is a hole waiting for the next
    call site to be added under it — the allowlist has to shrink as the refactor
    lands, not accumulate.
    """
    by_file = {rel: path for rel, path in _source_files()}
    dead: list[str] = []
    for rel, names in ALLOWED.items():
        path = by_file.get(rel)
        if path is None:
            dead.append(f"{rel} (file not scanned)")
            continue
        lines = _code_lines(path.read_text(encoding="utf-8"))
        for name in names:
            if not any(PATTERNS[name].search(line) for line in lines):
                dead.append(f"{rel}: '{name}' no longer occurs")
    assert not dead, "Unnecessary grep-gate exemptions:\n" + "\n".join(dead)


# --------------------------------------------------------------------------- #
# Behaviour of the primitives
# --------------------------------------------------------------------------- #
pytestmark = pytest.mark.django_db


def test_owner_kwargs_sets_exactly_one_side(user, guest_session):
    session, _ = guest_session
    assert owner_kwargs(user) == {"owner": user}
    assert owner_kwargs(session) == {"guest_session": session}
    assert job_owner_kwargs(user) == {"user": user}
    assert job_owner_kwargs(session) == {"guest_session": session}


def test_owner_kwargs_refuses_a_none_principal():
    """A None principal must never silently produce `owner=None`, which is the
    exact shape that violates the constraint *and* matches every guest's rows."""
    with pytest.raises(ValueError):
        owner_kwargs(None)
    with pytest.raises(ValueError):
        job_owner_kwargs(None)


def test_owned_by_none_matches_nothing_not_everything(uploaded_doc):
    from apps.documents.models import Document

    assert owned_by(Document.objects.all(), None).count() == 0


def test_owned_by_scopes_to_the_principal(uploaded_doc, user, guest_doc, guest):
    from apps.documents.models import Document

    session = GuestSession.objects.get(pk=guest.token and _session_pk(guest))
    assert owned_by(Document.objects.all(), user).count() == 1
    assert owned_by(Document.objects.all(), session).count() == 1
    assert owned_by(Document.objects.all(), user).first().id != session.documents.first().id


def _session_pk(client):
    from apps.core.models import hash_guest_token

    return GuestSession.objects.get(token_hash=hash_guest_token(client.token)).pk


def test_owned_by_returns_nothing_for_a_guest_on_an_account_only_model(guest_session, user):
    """`Folder` has no `guest_session` column (§21.2), so filtering it by a
    guest principal is a FieldError — a 500, not an empty result."""
    from apps.documents.models import Folder

    session, _ = guest_session
    Folder.objects.create(owner=user, name="Alice's folder")
    assert owned_by(Folder.objects.all(), session).count() == 0
    assert owned_by(Folder.objects.all(), user).count() == 1


def test_guest_uploading_into_a_folder_gets_404_not_500(guest, fixture_bytes, user):
    """The reachable path for the bug above: `POST /api/documents/` with a
    `folder` id, as a guest."""
    from django.core.files.uploadedfile import SimpleUploadedFile

    from apps.documents.models import Folder

    folder = Folder.objects.create(owner=user, name="Alice's folder")
    upload = SimpleUploadedFile(
        "text.pdf", fixture_bytes("text.pdf"), content_type="application/pdf"
    )
    resp = guest.post(
        "/api/documents/", {"file": upload, "folder": str(folder.id)}, format="multipart"
    )
    assert resp.status_code == 404, resp.content


def test_owns_is_false_for_a_guest_against_an_account_only_model(guest_session, user):
    from apps.documents.models import Folder

    session, _ = guest_session
    folder = Folder.objects.create(owner=user, name="Alice's folder")
    assert owns(folder, session) is False
    assert owns(folder, user) is True


def test_assert_owned_raises_404_never_403(uploaded_doc, guest_session):
    from rest_framework.exceptions import NotFound

    from apps.documents.models import Document

    session, _ = guest_session
    document = Document.objects.get(id=uploaded_doc["id"])
    with pytest.raises(NotFound) as exc:
        assert_owned(document, session)
    # 404, never 403: a 403 confirms the id exists, leaking the id space.
    assert exc.value.status_code == 404


def test_owns_never_crosses_principal_kinds(uploaded_doc, user, guest_session):
    from apps.documents.models import Document

    session, _ = guest_session
    document = Document.objects.get(id=uploaded_doc["id"])
    assert owns(document, user) is True
    assert owns(document, session) is False
    assert owns(document, None) is False


def test_principal_of_job_prefers_the_guest_session(user, guest_session):
    from apps.jobs.models import Job

    session, _ = guest_session
    account_job = Job.objects.create(user=user, type="noop_sleep")
    guest_job = Job.objects.create(guest_session=session, type="noop_sleep")
    assert principal_of(account_job) == user
    assert principal_of(guest_job) == session
    assert is_guest(principal_of(guest_job))
    assert is_account(principal_of(account_job))
