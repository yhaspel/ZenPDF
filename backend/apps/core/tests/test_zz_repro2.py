"""TEMPORARY review reproductions, part 2 — delete after the review."""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.django_db


def test_a_failed_deletion_rolls_back_the_rows_but_not_the_blobs(
        api, user, uploaded_doc, monkeypatch):
    """Storage is deleted inside the atomic block and before the row delete."""
    from apps.documents.models import Document
    from apps.pdf_engine.storage import get_storage
    from apps.users import privacy

    key = Document.objects.get(id=uploaded_doc["id"]).current_version.storage_key
    storage = get_storage()
    assert storage.get_bytes(key)

    original = privacy._detach_envelopes

    def explode(u):
        original(u)
        raise RuntimeError("simulated fault after the blobs are gone")

    monkeypatch.setattr(privacy, "_detach_envelopes", explode)

    with pytest.raises(RuntimeError):
        privacy.delete_account(user)

    from django.contrib.auth import get_user_model
    still_there = get_user_model().objects.filter(pk=user.pk).exists()
    doc_row = Document.objects.filter(id=uploaded_doc["id"]).exists()
    blob = True
    try:
        storage.get_bytes(key)
    except Exception:
        blob = False
    print("USER ROW SURVIVED:", still_there, "DOC ROW SURVIVED:", doc_row,
          "BLOB SURVIVED:", blob,
          "QUOTA:", type(user).objects.get(pk=user.pk).storage_bytes_used)


def test_reversing_migration_0003_after_a_deletion(api, user, uploaded_doc):
    """`AlterField` back to NOT NULL cannot apply once a row has owner=NULL."""
    from django.db import connection
    from apps.esign.models import SignRequest

    SignRequest.objects.create(owner=None, title="detached")
    with connection.cursor() as cur:
        cur.execute("SELECT count(*) FROM esign_signrequest WHERE owner_id IS NULL")
        print("NULL-owner rows:", cur.fetchone()[0])
        try:
            cur.execute("ALTER TABLE esign_signrequest "
                        "ALTER COLUMN owner_id SET NOT NULL")
            print("REVERSE MIGRATION WOULD SUCCEED")
        except Exception as exc:  # noqa: BLE001
            print("REVERSE MIGRATION WOULD FAIL:", type(exc).__name__, exc)


def test_trash_and_starred_still_use_an_index(user):
    from apps.core.principals import owned_by
    from apps.documents.models import Document
    from django.db import connection

    Document.objects.bulk_create([
        Document(owner=user, title=f"D{i}", status="ready", page_count=1,
                 size_bytes=10, starred=(i % 50 == 0),
                 trashed_at=None if i % 10 else "2026-01-01T00:00:00Z")
        for i in range(3000)
    ])
    with connection.cursor() as cur:
        cur.execute("ANALYZE documents_document")

    trash = owned_by(Document.objects.filter(trashed_at__isnull=False), user) \
        .order_by("-updated_at")[:24]
    print("TRASH PLAN:", trash.explain())
    starred = owned_by(Document.objects.filter(starred=True,
                                               trashed_at__isnull=True), user) \
        .order_by("-updated_at")[:24]
    print("STARRED PLAN:", starred.explain())
