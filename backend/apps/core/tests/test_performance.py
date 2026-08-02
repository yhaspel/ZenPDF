"""Performance characteristics that must survive a real library (§10.2).

Not benchmarks — the numbers a laptop produces are not the numbers production
produces. What these pin is **shape**: that the hot queries use an index rather
than sorting the whole table, that listing is paginated rather than unbounded,
and that the heavy lane cannot starve the cheap one.

Those are the properties that turn into an outage at 10 000 documents, and none
of them are visible on the 20-row library a feature test builds.
"""
from __future__ import annotations

import time

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


def test_the_library_list_uses_an_index_rather_than_sorting_everything(user):
    """`owned_by` + hide-trashed + newest-first is the single most-run query in
    the product; without `updated_at` in the index it sorts every row the
    filter matched, on every page load."""
    from apps.core.principals import owned_by
    from apps.documents.models import Document

    _seed_documents(user)
    plan = _plan(
        owned_by(Document.objects.filter(trashed_at__isnull=True), user)
        .order_by("-updated_at")[:24]
    )
    # The wording differs by backend (Postgres "Index Scan using …", SQLite
    # "SEARCH … USING INDEX …"), so assert on the index this query exists for.
    assert "doc_owner_trash_updated" in plan, plan
    assert "Seq Scan" not in plan, plan


def test_listing_a_large_library_stays_paginated_and_quick(api, user):
    _seed_documents(user)
    started = time.monotonic()
    resp = api.get("/api/documents/")
    elapsed = time.monotonic() - started

    assert resp.status_code == 200
    body = resp.json()
    # Paginated: an unbounded list is how a 10 000-document account becomes a
    # 40 MB response and a browser that stops responding.
    assert len(body["results"]) <= 100
    assert body["count"] == SEED
    assert elapsed < 2.0, f"{elapsed:.2f}s for one page of {SEED}"


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
