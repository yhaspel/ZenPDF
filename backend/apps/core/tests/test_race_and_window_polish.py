"""L3, L4, L5, L13 — the four checks that were true only when nobody hurried.

Each of these was correct against a single, serial caller and wrong against two
arriving together, or across a window boundary, or in a deployment nobody had
configured. None of them is a hole on its own; together they are the difference
between a limit and a suggestion.
"""
import pytest
from django.core.cache import cache

pytestmark = pytest.mark.django_db


# --------------------------------------------------------------------------- #
# L3 — the concurrency slot
# --------------------------------------------------------------------------- #
def test_the_slot_is_claimed_inside_a_transaction(api, uploaded_doc, settings,
                                                  monkeypatch):
    """Count-then-create is not a check: two POSTs that interleave between the
    count and the insert both pass. The re-check now runs inside the
    transaction that writes the row, holding the principal's own row.

    The hermetic suite is single-process SQLite, so the race cannot be staged
    here — what *can* be pinned is that the check runs at creation time and not
    only in the pre-flight, which is what makes locking possible at all.
    """
    import copy

    from apps.documents import views
    from apps.jobs.models import Job

    tiers = copy.deepcopy(settings.TIERS)
    tiers["free"]["max_concurrent_jobs"] = 1
    settings.TIERS = tiers

    seen: list[str] = []
    real_slot = views._concurrency_slot

    def watched(principal):
        seen.append("slot")
        return real_slot(principal)

    monkeypatch.setattr(views, "_concurrency_slot", watched)

    resp = api.post(f"/api/documents/{uploaded_doc['id']}/operations/",
                    {"type": "rotate_pages",
                     "params": {"pages": [0], "degrees": 90}}, format="json")
    assert resp.status_code == 202, resp.content
    assert seen == ["slot"], "the job was created outside the slot"
    assert Job.objects.count() >= 1


def test_a_principal_at_their_limit_is_still_refused(api, uploaded_doc, user,
                                                     settings):
    """The pre-flight message is unchanged — the fix must not cost the sentence
    that tells somebody what to do about it."""
    import copy

    from apps.jobs.models import Job

    tiers = copy.deepcopy(settings.TIERS)
    tiers["free"]["max_concurrent_jobs"] = 1
    settings.TIERS = tiers
    Job.objects.create(user=user, type="ocr", status=Job.Status.RUNNING)

    resp = api.post(f"/api/documents/{uploaded_doc['id']}/operations/",
                    {"type": "rotate_pages",
                     "params": {"pages": [0], "degrees": 90}}, format="json")
    assert resp.status_code == 429, resp.content
    body = resp.json()["error"]
    assert body["code"] == "quota_exceeded"
    assert "job(s) running" in body["message"]


# --------------------------------------------------------------------------- #
# L5 — the password-attempt window slides
# --------------------------------------------------------------------------- #
def test_the_password_window_cannot_be_doubled_across_a_boundary():
    """The fixed calendar minute allowed five guesses at :59 and five more at
    :00 — ten in one second, and the meter read five both times."""
    from apps.core import limits as L
    from apps.core.exceptions import QuotaExceeded

    cache.clear()
    doc_id = "11111111-1111-1111-1111-111111111111"

    # Five failures land in the newest bucket…
    for _ in range(L.PASSWORD_ATTEMPTS_PER_MINUTE):
        L.record_password_failure(doc_id)
    with pytest.raises(QuotaExceeded):
        L.enforce_password_attempts(doc_id)

    # …and are still counted from a bucket several steps later, which is
    # exactly what a fixed window forgot at the boundary.
    keys = L._password_keys(doc_id)
    assert len(keys) == (L.PASSWORD_ATTEMPT_WINDOW_SECONDS
                         // L.PASSWORD_ATTEMPT_BUCKET_SECONDS)
    assert L.password_failures_in_window(doc_id) == L.PASSWORD_ATTEMPTS_PER_MINUTE


def test_attempts_older_than_the_window_stop_counting():
    """It is a rate limit, not a lockout: the owner who mistyped gets back in."""
    from apps.core import limits as L

    cache.clear()
    doc_id = "22222222-2222-2222-2222-222222222222"
    stale = L._password_keys(doc_id)[-1]
    # One bucket older than the oldest the window looks at.
    older = f"{stale.rsplit(':', 1)[0]}:{int(stale.rsplit(':', 1)[1]) - 1}"
    cache.set(older, 99, timeout=300)

    assert L.password_failures_in_window(doc_id) == 0
    L.enforce_password_attempts(doc_id)  # does not raise


def test_four_failures_do_not_lock_the_document():
    from apps.core import limits as L

    cache.clear()
    doc_id = "33333333-3333-3333-3333-333333333333"
    for _ in range(L.PASSWORD_ATTEMPTS_PER_MINUTE - 1):
        L.record_password_failure(doc_id)
    L.enforce_password_attempts(doc_id)  # does not raise


# --------------------------------------------------------------------------- #
# L13 — production must name itself
# --------------------------------------------------------------------------- #
@pytest.fixture
def load_prod_settings(monkeypatch):
    """Import `config.settings.prod` under a chosen environment.

    `prod` does `from .base import *`, and base is already in `sys.modules`, so
    reloading prod alone would pick up the values base captured at *its* import
    — the dev environment, not the one under test, which would make these tests
    pass without reading anything. Both are reloaded, and base is restored
    afterwards so no other test sees a settings module built from here.
    """
    import contextlib
    import importlib
    import sys

    base = importlib.import_module("config.settings.base")

    def load(**env):
        for key, value in env.items():
            monkeypatch.setenv(key, value)
        importlib.reload(base)
        # Imported *inside*, never at fixture setup: importing prod under the
        # dev environment is exactly what these tests are asserting fails.
        prod = sys.modules.get("config.settings.prod")
        if prod is None:
            return importlib.import_module("config.settings.prod")
        return importlib.reload(prod)

    yield load

    monkeypatch.undo()
    with contextlib.suppress(Exception):
        importlib.reload(base)


@pytest.mark.parametrize("hosts", ["", "*", "zenpdf.example.com,*"])
def test_production_refuses_to_boot_without_real_allowed_hosts(hosts,
                                                               load_prod_settings):
    """`ALLOWED_HOSTS=*` in production accepts any Host header, and every
    absolute URL we mail is built from it."""
    from django.core.exceptions import ImproperlyConfigured

    with pytest.raises(ImproperlyConfigured, match="ALLOWED_HOSTS"):
        load_prod_settings(SECRET_KEY="not-the-repository-one",
                           ALLOWED_HOSTS=hosts)


def test_production_boots_when_it_is_told_its_hostname(load_prod_settings):
    module = load_prod_settings(SECRET_KEY="not-the-repository-one",
                                ALLOWED_HOSTS="zenpdf.example.com")
    assert module.ALLOWED_HOSTS == ["zenpdf.example.com"]


def test_the_secret_key_stance_is_unchanged(load_prod_settings):
    """The guard above is modelled on this one; neither may weaken the other."""
    from django.core.exceptions import ImproperlyConfigured

    with pytest.raises(ImproperlyConfigured, match="SECRET_KEY"):
        load_prod_settings(SECRET_KEY="", ALLOWED_HOSTS="zenpdf.example.com")
