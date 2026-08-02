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
