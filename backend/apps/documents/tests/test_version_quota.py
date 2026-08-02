"""The storage quota on the version write path (§16).

Upload, image assets and claim all check the quota. The version write did not:
`_save_new_version` bumped the counter and never read it, so a principal
already past their quota kept minting versions indefinitely. That is the hole
`version_retention` was reaching for and could not close — a per-*document*
cap does not bound a per-*principal* cost.
"""
import copy

import pytest
from django.conf import settings

pytestmark = pytest.mark.django_db


def _rotate(api, doc_id):
    return api.post(
        f"/api/documents/{doc_id}/operations/",
        {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90}},
        format="json",
    )


def test_a_principal_over_quota_cannot_mint_another_version(api, uploaded_doc,
                                                            user, settings):
    from apps.jobs.models import Job

    tiers = copy.deepcopy(settings.TIERS)
    tiers["free"]["storage_mb"] = 0          # already over, by definition
    settings.TIERS = tiers

    resp = _rotate(api, uploaded_doc["id"])
    assert resp.status_code == 202, resp.content
    job = Job.objects.get(id=resp.json()["id"])
    assert job.status == Job.Status.FAILED
    # The code the client switches on, not `engine_error`.
    assert job.error_code == "quota_exceeded"
    assert "storage" in job.error_message.lower()
    assert job.error_details["quota_bytes"] == 0


def test_the_refusal_leaves_the_document_exactly_as_it_was(api, uploaded_doc,
                                                           settings):
    """A version that lands and *then* fails a check has already cost the
    bytes — so the check runs before the blob is written."""
    import copy as _copy

    from apps.documents.models import Document

    before = Document.objects.get(id=uploaded_doc["id"])
    before_seq = before.current_version.seq
    before_count = before.versions.count()

    tiers = _copy.deepcopy(settings.TIERS)
    tiers["free"]["storage_mb"] = 0
    settings.TIERS = tiers
    _rotate(api, uploaded_doc["id"])

    after = Document.objects.get(id=uploaded_doc["id"])
    assert after.current_version.seq == before_seq
    assert after.versions.count() == before_count


def test_an_ordinary_edit_is_untouched_by_the_check(api, uploaded_doc):
    """The guard is only useful if it is not simply a wall."""
    from apps.documents.models import Document
    from apps.jobs.models import Job

    resp = _rotate(api, uploaded_doc["id"])
    job = Job.objects.get(id=resp.json()["id"])
    assert job.status == Job.Status.SUCCEEDED, job.error_message
    assert Document.objects.get(id=uploaded_doc["id"]).versions.count() == 2


def test_version_retention_is_no_longer_advertised(anon):
    """It was published to every client and enforced by nothing. Removing the
    number is half the fix; `enforce_storage` is the other half."""
    limits = anon.get("/api/config/").json()["limits"]
    assert "version_retention" not in limits
    assert not hasattr(settings, "VERSION_RETENTION")


def test_a_new_document_is_refused_too_not_just_a_new_version(api, uploaded_doc,
                                                              settings):
    """The door next to the one that was found open.

    `split` lands in `_create_document_from_bytes`, not `_save_new_version`,
    from the *same* endpoint — so checking only the version write leaves an
    over-quota principal writing 2 000 blobs with one request, and a
    split→merge cycle grows the account every round.
    """
    import copy as _copy

    from apps.documents.models import Document
    from apps.jobs.models import Job

    tiers = _copy.deepcopy(settings.TIERS)
    tiers["free"]["storage_mb"] = 0
    settings.TIERS = tiers

    before = Document.objects.count()
    resp = api.post(
        f"/api/documents/{uploaded_doc['id']}/operations/",
        {"type": "split", "params": {"mode": "every_n", "every_n": 1}},
        format="json",
    )
    job = Job.objects.get(id=resp.json()["id"])
    assert job.status == Job.Status.FAILED
    assert job.error_code == "quota_exceeded"
    assert Document.objects.count() == before, "no document may survive a refusal"


def test_the_check_reads_the_counter_it_is_bumping(user, settings):
    """A loop must not pass on the value its first iteration saw.

    `bump_storage` writes with `F()` and never refreshes the instance it was
    handed, and a worker resolves its principal once per job — so a naive
    `principal.storage_bytes_used` returns the same number for every item of a
    split. Measured before the fix: a three-page split saw `2898, 2898, 2898`
    while the row read `2898, 3769, 4639`, and one request took an account from
    under quota to nearly twice it.
    """
    import copy as _copy

    from apps.core import limits as L
    from apps.core.exceptions import QuotaExceeded

    stale = user.storage_bytes_used
    L.bump_storage(user, 1_000_000)
    assert user.storage_bytes_used == stale, "the instance is stale by design"
    assert L.storage_used_fresh(user) == stale + 1_000_000

    # Ten writes of 100 KB against 500 KB of headroom: the sixth must refuse.
    tiers = _copy.deepcopy(settings.TIERS)
    tiers["free"]["storage_mb"] = 0
    settings.TIERS = tiers
    settings.TIERS["free"]["storage_mb"] = (stale + 1_500_000) // (1024 * 1024) + 1
    quota = L.for_principal(user).storage_bytes
    chunk = 100_000
    written = 0
    with pytest.raises(QuotaExceeded):
        for _ in range(200):
            L.enforce_storage(user, chunk)
            L.bump_storage(user, chunk)
            written += chunk
    assert L.storage_used_fresh(user) <= quota, "the loop overran the quota"
    assert written > 0, "the first write should have been allowed"


def test_a_split_refused_partway_leaves_no_orphans(api, uploaded_doc, settings,
                                                   user):
    """`split` is the one operation whose refusal is naturally partial.

    With a per-item check, headroom for the first page and not the last leaves
    the earlier documents behind — real rows, real blobs, real charge, attached
    to a job that says it failed. So the batch is measured before any of it is
    written. Half the room the whole split needs must refuse *all* of it, not
    most of it.
    """
    from apps.core import limits as L
    from apps.documents.models import Document
    from apps.jobs.models import Job

    # 1. Learn what this split actually costs, with room to spare.
    resp = api.post(
        f"/api/documents/{uploaded_doc['id']}/operations/",
        {"type": "split", "params": {"mode": "every_n", "every_n": 1}},
        format="json",
    )
    assert Job.objects.get(id=resp.json()["id"]).status == Job.Status.SUCCEEDED
    made = Document.objects.exclude(id=uploaded_doc["id"])
    assert made.count() > 1, "a one-document split cannot be partial"
    cost = sum(d.current_version.size_bytes for d in made)
    made.delete()

    # 2. Leave exactly half of it. The quota is whole megabytes and this
    #    fixture is kilobytes, so the headroom is set through the counter.
    quota = L.for_principal(user).storage_bytes
    L.bump_storage_by_id("user", user.pk,
                         (quota - cost // 2) - L.storage_used_fresh(user))

    before = Document.objects.count()
    resp = api.post(
        f"/api/documents/{uploaded_doc['id']}/operations/",
        {"type": "split", "params": {"mode": "every_n", "every_n": 1}},
        format="json",
    )
    job = Job.objects.get(id=resp.json()["id"])
    assert job.status == Job.Status.FAILED, "half the room is not enough room"
    assert job.error_code == "quota_exceeded"
    assert Document.objects.count() == before, "a partial split left orphans"
