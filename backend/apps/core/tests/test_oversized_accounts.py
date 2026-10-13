"""`oversized_accounts` — the storage-hygiene shortlist (§9B).

It is a report for a human, so what matters is that the numbers it prints are
the numbers a decision needs: the ratio against the account's *own* tier
quota (a free account at 90% must sort above a pro account at 30% even though
the pro account holds ten times the bytes), the trailing count that survives
`--limit`, and "never" for an account that has not touched a document.
"""
from io import StringIO

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.test import override_settings

from apps.core import limits as L

pytestmark = pytest.mark.django_db

User = get_user_model()
MB = 1024 * 1024


def _run(*args) -> str:
    out = StringIO()
    call_command("oversized_accounts", *args, stdout=out)
    return out.getvalue()


def _account(email: str, used_mb: int, *, plan: str = "free"):
    user = User.objects.create_user(email=email, password="pass12345", plan=plan)
    User.objects.filter(pk=user.pk).update(storage_bytes_used=used_mb * MB)
    return user


def test_reports_when_no_account_is_over_the_threshold(user):
    assert "No account is over that threshold." in _run()


def test_an_account_under_the_threshold_is_not_listed():
    quota_mb = L.for_tier("free").storage_bytes // MB
    _account("quiet@example.com", quota_mb // 2)
    out = _run("--over", "80")
    assert "quiet@example.com" not in out
    assert "No account is over that threshold." in out


def test_an_account_over_the_threshold_is_listed_with_its_numbers():
    quota_mb = L.for_tier("free").storage_bytes // MB
    _account("heavy@example.com", quota_mb * 9 // 10)
    out = _run("--over", "80")
    line = next(ln for ln in out.splitlines() if ln.startswith("heavy@example.com"))
    assert f"{quota_mb * 9 // 10:>8} MB" in line
    assert f"{quota_mb:>8} MB" in line
    assert "90%" in line
    assert line.rstrip().endswith("never")
    assert "1 account(s) over 80%." in out


def test_rows_sort_by_ratio_of_own_quota_not_by_raw_bytes():
    """A smaller account on a smaller tier can still be the worse offender —
    and the query is ordered by raw bytes, so a sort on ratio must follow."""
    free_quota_mb = L.for_tier("free").storage_bytes // MB
    pro_quota_mb = L.for_tier("pro").storage_bytes // MB
    assert pro_quota_mb > free_quota_mb
    _account("small-but-full@example.com", free_quota_mb * 95 // 100)
    # More bytes than the free account, far under its own pro quota.
    _account("big-but-fine@example.com", free_quota_mb * 2, plan="pro")

    out = _run("--over", "1")
    emails = [ln.split()[0] for ln in out.splitlines() if "@example.com" in ln]
    assert emails == ["small-but-full@example.com", "big-but-fine@example.com"]


def test_a_pro_account_is_judged_against_the_pro_quota():
    free_quota_mb = L.for_tier("free").storage_bytes // MB
    _account("pro@example.com", free_quota_mb * 2, plan="pro")
    out = _run("--over", "80")
    assert "pro@example.com" not in out


def test_limit_truncates_the_rows_but_the_count_reports_every_account():
    quota_mb = L.for_tier("free").storage_bytes // MB
    for i in range(4):
        _account(f"over{i}@example.com", quota_mb * (85 + i) // 100)

    out = _run("--over", "80", "--limit", "2")
    listed = [ln for ln in out.splitlines() if "@example.com" in ln]
    assert len(listed) == 2
    assert "4 account(s) over 80%." in out


def test_last_activity_shows_the_date_of_the_newest_document(api, uploaded_doc, user):
    quota_mb = L.for_tier("free").storage_bytes // MB
    User.objects.filter(pk=user.pk).update(storage_bytes_used=quota_mb * MB)
    from apps.documents.models import Document

    newest = Document.objects.filter(owner=user).order_by("-updated_at").first()
    out = _run("--over", "80")
    line = next(ln for ln in out.splitlines() if ln.startswith(user.email))
    assert line.rstrip().endswith(str(newest.updated_at.date()))
    assert "never" not in line


def test_an_account_with_a_zero_quota_is_skipped_rather_than_divided_by():
    tiers = {**L.settings.TIERS, "free": {**L.settings.TIERS["free"], "storage_mb": 0}}
    _account("zero@example.com", 500)
    with override_settings(TIERS=tiers):
        out = _run("--over", "0")
    assert "zero@example.com" not in out
    assert "No account is over that threshold." in out
