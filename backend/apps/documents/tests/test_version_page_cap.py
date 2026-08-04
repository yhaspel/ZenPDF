"""H2 — the tier page cap on the version write path (§16, §17).

Ingest checks `max_pages`, and so does the document-creating branch of the
worker. The version write did not, and the storage quota does not stand in for
it: duplicated pages share their content xrefs, so `duplicate_pages` multiplies
the page count for almost no bytes. A guest could walk a 3-page document past
the 300-page cap in a handful of jobs and make every later operation on it cost
more.
"""
import copy

import pytest

pytestmark = pytest.mark.django_db


def _op(client, doc_id, type_, params):
    return client.post(f"/api/documents/{doc_id}/operations/",
                       {"type": type_, "params": params}, format="json")


@pytest.fixture
def guest_cap_4(settings):
    """A guest tier whose page cap sits just above the 3-page fixture."""
    tiers = copy.deepcopy(settings.TIERS)
    tiers["guest"]["max_pages"] = 4
    settings.TIERS = tiers
    return tiers


def test_duplicate_past_the_cap_is_refused(guest, guest_doc, guest_cap_4):
    """3 pages + 3 duplicates = 6, and the cap is 4."""
    from apps.jobs.models import Job

    resp = _op(guest, guest_doc["id"], "duplicate_pages", {"pages": [0, 1, 2]})
    assert resp.status_code == 202, resp.content

    job = Job.objects.get(id=resp.json()["id"])
    assert job.status == Job.Status.FAILED
    assert job.error_code == "validation_error"
    assert "6-page" in job.error_message and "limit is 4" in job.error_message
    assert job.error_details == {"pages": 6, "max_pages": 4, "tier": "guest"}
    # A guest is told the cap is a tier, not a wall.
    assert "free account" in job.error_message


def test_the_refusal_writes_no_version(guest, guest_doc, guest_cap_4):
    """The check runs before the blob, so a refusal costs nothing and leaves
    the version chain exactly where it was."""
    from apps.documents.models import Document

    before = Document.objects.get(id=guest_doc["id"])
    before_seq, before_count = before.current_version.seq, before.versions.count()
    before_storage = before.current_version.storage_key

    _op(guest, guest_doc["id"], "duplicate_pages", {"pages": [0, 1, 2]})

    after = Document.objects.get(id=guest_doc["id"])
    assert after.versions.count() == before_count
    assert after.current_version.seq == before_seq
    assert after.current_version.storage_key == before_storage


def test_an_edit_that_lands_on_the_cap_still_succeeds(guest, guest_doc, guest_cap_4):
    """The guard is only useful if it is not simply a wall: 3 + 1 = 4 is fine."""
    from apps.documents.models import Document
    from apps.jobs.models import Job

    resp = _op(guest, guest_doc["id"], "duplicate_pages", {"pages": [0]})
    job = Job.objects.get(id=resp.json()["id"])
    assert job.status == Job.Status.SUCCEEDED, job.error_message
    assert Document.objects.get(id=guest_doc["id"]).current_version.page_count == 4


def test_an_account_is_not_offered_an_account(api, uploaded_doc, settings):
    """The upsell sentence belongs to guests only."""
    from apps.jobs.models import Job

    tiers = copy.deepcopy(settings.TIERS)
    tiers["free"]["max_pages"] = 4
    settings.TIERS = tiers

    resp = _op(api, uploaded_doc["id"], "duplicate_pages", {"pages": [0, 1, 2]})
    job = Job.objects.get(id=resp.json()["id"])
    assert job.status == Job.Status.FAILED
    assert job.error_code == "validation_error"
    assert "free account" not in job.error_message


def test_an_absurd_page_array_is_refused_at_validation(guest, guest_doc):
    """Defence in depth: the schema's `maxItems` stops a million-element array
    from reaching the engine at all — a 400, not a job that dies later."""
    resp = _op(guest, guest_doc["id"], "duplicate_pages",
               {"pages": [0] * 10_001})
    assert resp.status_code == 400, resp.content
    assert resp.json()["error"]["code"] == "validation_error"
