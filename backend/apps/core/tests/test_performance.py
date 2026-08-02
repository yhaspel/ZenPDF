"""Performance characteristics that must survive a real library (§10.2).

Not benchmarks — the numbers a laptop produces are not the numbers production
produces. What these pin is **shape**: that the hot queries use an index rather
than sorting the whole table, that listing is paginated rather than unbounded,
and that the heavy lane cannot starve the cheap one.

Those are the properties that turn into an outage at 10 000 documents, and none
of them are visible on the 20-row library a feature test builds.
"""
from __future__ import annotations

import pytest
from django.db import connection

pytestmark = pytest.mark.django_db

#: Enough rows that Postgres prefers an index, without making the suite slow.
SEED = 3000


def _seed_documents(owner, count=SEED):
    from apps.documents.models import Document

    Document.objects.bulk_create([
        Document(owner=owner, title=f"Document {i}", status="ready",
                 page_count=3, size_bytes=1024)
        for i in range(count)
    ])
    with connection.cursor() as cursor:
        # Without this the planner is working from stale statistics and will
        # seq-scan a table it has never looked at.
        cursor.execute("ANALYZE documents_document")


def _plan(queryset) -> str:
    return queryset.explain()


#: Query plans are backend-specific, and the hermetic suite runs on SQLite —
#: where `assert "Seq Scan" not in plan` is vacuous. These run under
#: `config.settings.dev` (Postgres): `./infra/test.sh --pg`.
PG_ONLY = pytest.mark.skipif(
    connection.vendor != "postgresql",
    reason="query plans are backend-specific; the suite's SQLite would make "
           "this assertion vacuous")


@PG_ONLY
def test_the_library_list_needs_no_sort(user):
    """`owned_by` + hide-trashed + newest-first is the single most-run query in
    the product, and it must not sort.

    A **partial** index, not a composite one: `trashed_at IS NULL` is a null
    test rather than an equality, so Postgres keeps `trashed_at` in a composite
    index's sort key and `ORDER BY updated_at DESC` still costs a Sort. That
    was the first attempt, and it bought a wider index for nothing.
    """
    from apps.core.principals import owned_by
    from apps.documents.models import Document

    _seed_documents(user)
    plan = _plan(
        owned_by(Document.objects.filter(trashed_at__isnull=True), user)
        .order_by("-updated_at")[:24]
    )
    assert "doc_owner_live_updated" in plan, plan
    assert "Sort" not in plan, plan
    assert "Seq Scan" not in plan, plan


def test_listing_a_large_library_stays_paginated(api, user,
                                                 django_assert_max_num_queries):
    """Paginated, and a *constant* number of queries.

    No wall-clock assertion: a second on a loaded CI machine is not a second in
    production, and the failure it produces is noise rather than a finding.
    What does generalise is the query count — an N+1 here is 3 000 round trips
    however fast the box is.
    """
    _seed_documents(user)
    with django_assert_max_num_queries(12):
        resp = api.get("/api/documents/")

    assert resp.status_code == 200
    body = resp.json()
    # An unbounded list is how a 10 000-document account becomes a 40 MB
    # response and a browser that stops responding.
    assert len(body["results"]) <= 100
    assert body["count"] == SEED


def test_the_audit_chain_reads_by_index(api, uploaded_doc, user):
    """The certificate reads every event in order, and every append reads the
    tail — both are one index."""
    from apps.esign.models import AuditEvent, SignRequest

    user.email_verified = True
    user.save(update_fields=["email_verified"])
    request = SignRequest.objects.create(owner=user, title="Chain",
                                         document_id=uploaded_doc["id"])
    plan = _plan(AuditEvent.objects.filter(sign_request=request)
                 .order_by("created_at"))
    assert "audit_request_created" in plan, plan


def test_the_heavy_lane_cannot_starve_the_cheap_one():
    """§12's whole point: an hour of OCR must not stop somebody rotating a
    page. The isolation is the queue assignment, so that is what is asserted —
    a cheap op that ever routes to `heavy` silently ends this guarantee."""
    from apps.core.limits import METERED_OPS
    from apps.pdf_engine.registry import OPERATIONS

    # The single-document page work a first-time visitor does. Friction here is
    # what the anonymous-first strategy exists to avoid, so none of it may sit
    # behind an OCR run. (`merge` and `compress` are legitimately heavy: one
    # reads several documents, the other re-encodes every image.)
    cheap = {"rotate_pages", "delete_pages", "reorder_pages", "extract_pages",
             "crop_pages", "split", "self_sign", "encrypt", "decrypt",
             "sanitize", "fill_form", "annotate_batch"}
    for op_type in cheap:
        op = OPERATIONS.get(op_type)
        assert op is not None, f"{op_type} vanished from the registry"
        assert op.queue != "heavy", f"{op_type} would queue behind an OCR run"

    # …and everything metered is on the slow lane, where its own time limits
    # apply. A metered op on `default` would be killed at 60 s mid-run.
    for op_type in METERED_OPS:
        op = OPERATIONS.get(op_type)
        assert op is not None, f"{op_type} vanished from the registry"
        assert op.queue == "heavy", f"{op_type} would block the cheap lane"


def test_thumbnails_have_their_own_lane():
    """Rendering is neither cheap nor a user-visible operation; on either of
    the other two lanes it competes with work somebody is waiting for."""
    from django.conf import settings

    routes = settings.CELERY_TASK_ROUTES
    assert routes["apps.documents.tasks.generate_thumbnails_task"]["queue"] == "render"


def _seed_jobs(user, count=SEED):
    from apps.jobs.models import Job

    Job.objects.bulk_create([
        Job(user=user, type="rotate_pages",
            status="queued" if i % 97 == 0 else "succeeded")
        for i in range(count)
    ])
    with connection.cursor() as cursor:
        cursor.execute("ANALYZE jobs_job")


@PG_ONLY
def test_the_job_list_needs_no_sort(user):
    """`jobs_job` has no purge — `reap_stalled_jobs` only fails stuck rows — so
    an account's history only grows, and one page of 50 must not read all of
    it."""
    from apps.core.principals import owned_by
    from apps.jobs.models import Job

    _seed_jobs(user)
    plan = _plan(owned_by(Job.objects.all(), user).order_by("-created_at")[:50])
    assert "job_user_recent" in plan, plan
    assert "Sort" not in plan, plan
    assert "Seq Scan" not in plan, plan


@PG_ONLY
def test_the_concurrency_precheck_still_has_its_own_index(user):
    """`(user, status)` has to survive the new index: it is read on **every**
    operation dispatch, which is far hotter than the list."""
    from apps.core.principals import owned_by
    from apps.jobs.models import Job

    _seed_jobs(user)
    plan = _plan(owned_by(
        Job.objects.filter(status__in=[Job.Status.QUEUED, Job.Status.RUNNING]),
        user,
    ))
    assert "Seq Scan" not in plan, plan
    assert "Index" in plan, plan


@PG_ONLY
def test_the_sign_request_list_needs_no_sort(user):
    """The sender's own screen. Without `(owner, -created_at)` the plan reads
    every envelope the account ever sent, probes `documents_document` once per
    row for the `select_related`, then top-N heapsorts."""
    from apps.esign.models import SignRequest

    SignRequest.objects.bulk_create([
        SignRequest(owner=user, title=f"Envelope {i}",
                    envelope_code=f"PERF{i:012d}")
        for i in range(SEED)
    ])
    with connection.cursor() as cursor:
        cursor.execute("ANALYZE esign_signrequest")

    plan = _plan(SignRequest.objects.filter(owner=user)
                 .select_related("document")[:50])
    assert "sign_owner_recent" in plan, plan
    assert "Sort" not in plan, plan
    assert "Seq Scan on esign_signrequest" not in plan, plan
