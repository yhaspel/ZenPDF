"""Worker-path ownership — trap 1 (§21.2, phase-02b).

Ownership in Celery tasks flows through `job.user`, not `request.user`. For a
guest job `job.user` is `None`, which fails two ways at once:

  1. `_create_document_from_bytes(owner=job.user, …)` writes a row with
     `owner=None` *and* `guest_session=None` → violates the exactly-one-of
     CheckConstraint → IntegrityError on every guest split / merge / extract /
     alternate_mix — precisely the `/merge-pdf` and `/split-pdf` pages this
     phase exists to ship;
  2. `Document.objects.get(id=…, owner=job.user)` becomes `owner_id IS NULL`,
     so the worker-side ownership re-check degenerates into "*any* guest's
     document with that id" — a cross-tenant read.

The grep test catches the *spelling*. These catch the *behaviour*, which is why
the plan asks for both.
"""
import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

pytestmark = pytest.mark.django_db


def _upload(client, fixture_bytes, name="text.pdf"):
    upload = SimpleUploadedFile(name, fixture_bytes(name), content_type="application/pdf")
    resp = client.post("/api/documents/", {"file": upload}, format="multipart")
    assert resp.status_code == 201, resp.content
    return resp.json()


def _session_of(client):
    from apps.core.models import GuestSession, hash_guest_token

    return GuestSession.objects.get(token_hash=hash_guest_token(client.token))


# --------------------------------------------------------------------------- #
# Bug 1: document creation must not violate the constraint
# --------------------------------------------------------------------------- #
def test_guest_split_creates_documents_owned_by_the_same_session(guest, fixture_bytes):
    doc = _upload(guest, fixture_bytes)
    resp = guest.post(
        f"/api/documents/{doc['id']}/operations/",
        {"type": "split", "params": {"mode": "every_n", "every_n": 1}},
        format="json",
    )
    assert resp.status_code == 202, resp.content
    job = guest.get(f"/api/jobs/{resp.json()['id']}/").json()
    assert job["status"] == "succeeded", job

    from apps.documents.models import Document

    session = _session_of(guest)
    created = job["result"]["documents"]
    assert len(created) == 3  # text.pdf is 3 pages
    for doc_id in created:
        new_doc = Document.objects.get(id=doc_id)
        assert new_doc.guest_session_id == session.id
        assert new_doc.owner_id is None
        # Reachable by the guest that made it, through the API.
        assert guest.get(f"/api/documents/{doc_id}/").status_code == 200


def test_guest_extract_as_new_document_is_owned_by_the_session(guest, fixture_bytes):
    doc = _upload(guest, fixture_bytes)
    resp = guest.post(
        f"/api/documents/{doc['id']}/operations/",
        {"type": "extract_pages", "params": {"pages": [0], "as_new_document": True}},
        format="json",
    )
    job = guest.get(f"/api/jobs/{resp.json()['id']}/").json()
    assert job["status"] == "succeeded", job

    from apps.documents.models import Document

    new_doc = Document.objects.get(id=job["result"]["documents"][0])
    assert new_doc.guest_session_id == _session_of(guest).id
    assert new_doc.owner_id is None


def test_guest_merge_creates_a_document_owned_by_the_session(guest, fixture_bytes):
    """The flagship tool page. If trap 1 is live this raises IntegrityError."""
    a = _upload(guest, fixture_bytes, "text.pdf")
    b = _upload(guest, fixture_bytes, "unicode.pdf")
    resp = guest.post(
        "/api/operations/",
        {"type": "merge", "params": {"document_ids": [a["id"], b["id"]]}},
        format="json",
    )
    assert resp.status_code == 202, resp.content
    job = guest.get(f"/api/jobs/{resp.json()['id']}/").json()
    assert job["status"] == "succeeded", job

    from apps.documents.models import Document

    merged = Document.objects.get(id=job["result"]["documents"][0])
    assert merged.guest_session_id == _session_of(guest).id
    assert merged.owner_id is None
    assert merged.title.startswith("Merged")


def test_guest_storage_is_charged_to_the_session_not_the_users_table(guest, fixture_bytes):
    """`_bump_storage(user_id=None, …)` was `UPDATE users … WHERE id IS NULL`
    — a silent no-op that made the 200 MB guest cap unenforceable."""
    doc = _upload(guest, fixture_bytes)
    session = _session_of(guest)
    after_upload = session.storage_bytes_used
    assert after_upload > 0

    guest.post(
        f"/api/documents/{doc['id']}/operations/",
        {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90}},
        format="json",
    )
    session.refresh_from_db()
    assert session.storage_bytes_used > after_upload


# --------------------------------------------------------------------------- #
# Bug 2: the worker-side ownership re-check must not match any guest's rows
# --------------------------------------------------------------------------- #
def test_guest_cannot_merge_another_guests_document(guest, other_guest, fixture_bytes):
    mine = _upload(guest, fixture_bytes, "text.pdf")
    theirs = _upload(other_guest, fixture_bytes, "unicode.pdf")

    resp = guest.post(
        "/api/operations/",
        {"type": "merge", "params": {"document_ids": [mine["id"], theirs["id"]]}},
        format="json",
    )
    # Rejected at the API boundary, as another principal's id simply does not
    # resolve for this one.
    assert resp.status_code == 404


def test_worker_ownership_recheck_rejects_a_foreign_source_document(
    guest, other_guest, fixture_bytes
):
    """Defence in depth: bypass the API check and drive the worker directly.

    A job row is forged with a source document owned by a *different* guest —
    the shape an attacker gets if the view-level check is ever bypassed. With
    `owner=job.user` (→ `owner_id IS NULL`) this would happily read the other
    guest's file; through `principal_of(job)` it must not resolve.
    """
    mine = _upload(guest, fixture_bytes, "text.pdf")
    theirs = _upload(other_guest, fixture_bytes, "unicode.pdf")

    from apps.documents.tasks import run_cross_document_operation
    from apps.jobs.models import Job

    job = Job.objects.create(
        guest_session=_session_of(guest),
        type="merge",
        params={"document_ids": [mine["id"], theirs["id"]]},
    )
    run_cross_document_operation(str(job.id))
    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "not_found"


def test_worker_source_lookup_is_scoped_for_insert_from_document(
    guest, other_guest, fixture_bytes
):
    mine = _upload(guest, fixture_bytes, "text.pdf")
    theirs = _upload(other_guest, fixture_bytes, "unicode.pdf")

    from apps.documents.models import Document
    from apps.documents.tasks import run_operation
    from apps.jobs.models import Job

    job = Job.objects.create(
        guest_session=_session_of(guest),
        document=Document.objects.get(id=mine["id"]),
        type="insert_from_document",
        params={"source_document_id": theirs["id"], "at_index": 0},
    )
    run_operation(str(job.id))
    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "not_found"


def test_account_worker_paths_still_behave(api, uploaded_doc, user):
    """No regression for authenticated users from the refactor."""
    resp = api.post(
        f"/api/documents/{uploaded_doc['id']}/operations/",
        {"type": "split", "params": {"mode": "every_n", "every_n": 1}},
        format="json",
    )
    job = api.get(f"/api/jobs/{resp.json()['id']}/").json()
    assert job["status"] == "succeeded", job

    from apps.documents.models import Document

    for doc_id in job["result"]["documents"]:
        created = Document.objects.get(id=doc_id)
        assert created.owner_id == user.id
        assert created.guest_session_id is None
