"""Storage paths `test_storage.py` leaves out (§13, §21.4).

The S3 listing calls are what `guest_purge` and `usage_recompute` stand on:
a listing that stopped at the first page would silently orphan every
thumbnail past it and under-charge every account whose uploads span two
pages. The fake client here answers two pages so that pagination, not just
the call, is what is asserted. The rest is the backend selector and the
health check's one promise: it answers False, never raises.
"""
import datetime as dt
import io
from unittest import mock
from unittest.mock import MagicMock

import pytest

from apps.pdf_engine import storage as ST
from apps.pdf_engine.storage import FilesystemStorage, S3Storage


@pytest.fixture
def s3(settings):
    settings.STORAGE_BACKEND = "s3"
    st = S3Storage()
    st._client = MagicMock()
    st._public_client = MagicMock()
    return st


def _two_pages(client, prefix_seen: list):
    """A paginator whose `paginate` yields two pages and records the prefix."""
    when = dt.datetime(2026, 10, 1, 12, 0, tzinfo=dt.UTC)

    def paginate(*, Bucket, Prefix):
        prefix_seen.append((Bucket, Prefix))
        yield {"Contents": [{"Key": f"{Prefix}a.pdf", "Size": 10, "LastModified": when},
                            {"Key": f"{Prefix}b.png", "Size": 20, "LastModified": when}]}
        yield {"Contents": [{"Key": f"{Prefix}c.png", "Size": 30, "LastModified": when}]}
        yield {}  # a page with no Contents key: an empty final page

    paginator = MagicMock()
    paginator.paginate.side_effect = paginate
    client.get_paginator.return_value = paginator
    return when


def test_s3_delete_names_the_bucket_and_key(s3, settings):
    s3.delete("docs/1/v1.pdf")
    s3._client.delete_object.assert_called_once_with(Bucket=s3._bucket, Key="docs/1/v1.pdf")


def test_s3_list_prefix_walks_every_page(s3):
    seen = []
    _two_pages(s3._client, seen)
    keys = s3.list_prefix("thumbs/42/")
    assert keys == ["thumbs/42/a.pdf", "thumbs/42/b.png", "thumbs/42/c.png"]
    s3._client.get_paginator.assert_called_once_with("list_objects_v2")
    assert seen == [(s3._bucket, "thumbs/42/")]


def test_s3_detailed_listing_carries_size_and_an_aware_timestamp(s3):
    when = _two_pages(s3._client, [])
    rows = s3.list_prefix_detailed("uploads/u/7/")
    assert [r["key"] for r in rows] == ["uploads/u/7/a.pdf", "uploads/u/7/b.png",
                                        "uploads/u/7/c.png"]
    assert [r["size"] for r in rows] == [10, 20, 30]
    assert all(r["last_modified"] == when for r in rows)
    assert rows[0]["last_modified"].tzinfo is not None


def test_s3_detailed_listing_tolerates_a_missing_size(s3):
    paginator = MagicMock()
    paginator.paginate.return_value = [{"Contents": [{"Key": "k"}]}]
    s3._client.get_paginator.return_value = paginator
    assert s3.list_prefix_detailed("") == [{"key": "k", "size": 0, "last_modified": None}]


def test_s3_delete_prefix_deletes_each_listed_key_and_counts(s3):
    _two_pages(s3._client, [])
    assert s3.delete_prefix("thumbs/42/") == 3
    deleted = [c.kwargs["Key"] for c in s3._client.delete_object.call_args_list]
    assert deleted == ["thumbs/42/a.pdf", "thumbs/42/b.png", "thumbs/42/c.png"]


# --------------------------------------------------------------------------- #
# Filesystem
# --------------------------------------------------------------------------- #
def test_filesystem_listing_is_scoped_to_the_prefix(settings, tmp_path):
    settings.STORAGE_FS_ROOT = str(tmp_path)
    st = FilesystemStorage()
    st.put_bytes("thumbs/1/0/p1@200.png", b"x")
    st.put_bytes("thumbs/1/0/p2@200.png", b"xy")
    st.put_bytes("thumbs/2/0/p1@200.png", b"z")
    st.put_stream("docs/1/v1.pdf", io.BytesIO(b"pdf"))

    assert sorted(st.list_prefix("thumbs/1/")) == ["thumbs/1/0/p1@200.png",
                                                   "thumbs/1/0/p2@200.png"]
    rows = st.list_prefix_detailed("thumbs/1/")
    assert sorted((r["key"], r["size"]) for r in rows) == [
        ("thumbs/1/0/p1@200.png", 1), ("thumbs/1/0/p2@200.png", 2)]
    assert all(r["last_modified"].tzinfo is not None for r in rows)
    assert st.delete_prefix("thumbs/1/") == 2
    assert st.list_prefix("thumbs/") == ["thumbs/2/0/p1@200.png"]


def test_a_file_swept_between_the_walk_and_the_stat_is_skipped(settings, tmp_path):
    """`account_assets_purge` runs alongside uploads; a blob that vanishes
    mid-listing is nothing to report, not a reason to abort the listing."""
    import os

    settings.STORAGE_FS_ROOT = str(tmp_path)
    st = FilesystemStorage()
    st.put_bytes("uploads/u/1/a.png", b"x")
    st.put_bytes("uploads/u/1/b.png", b"xy")
    real_stat = os.stat

    def flaky(path, *args, **kwargs):
        if str(path).endswith("a.png"):
            raise FileNotFoundError(path)
        return real_stat(path, *args, **kwargs)

    with mock.patch.object(ST.os, "stat", side_effect=flaky):
        rows = st.list_prefix_detailed("uploads/u/1/")
    assert [r["key"] for r in rows] == ["uploads/u/1/b.png"]


def test_a_range_past_the_end_of_a_file_stops_at_the_end(settings, tmp_path):
    settings.STORAGE_FS_ROOT = str(tmp_path)
    st = FilesystemStorage()
    st.put_bytes("docs/1/v1.pdf", b"0123456789")
    assert b"".join(st.iter_range("docs/1/v1.pdf", 7, 500)) == b"789"


def test_filesystem_reset_empties_the_root_but_keeps_it_usable(settings, tmp_path):
    settings.STORAGE_FS_ROOT = str(tmp_path / "store")
    st = FilesystemStorage()
    st.put_bytes("docs/1/v1.pdf", b"pdf")
    st._reset()
    assert not st.exists("docs/1/v1.pdf")
    assert st.list_prefix("") == []
    assert st.healthy() is True
    st.put_bytes("docs/2/v1.pdf", b"again")
    assert st.get_bytes("docs/2/v1.pdf") == b"again"


# --------------------------------------------------------------------------- #
# Selection and health
# --------------------------------------------------------------------------- #
@pytest.fixture
def _fresh_selector():
    ST.get_storage.cache_clear()
    yield
    ST.get_storage.cache_clear()


def test_the_selector_builds_s3_when_configured(settings, _fresh_selector):
    settings.STORAGE_BACKEND = "s3"
    settings.S3_BUCKET = "zenpdf-test"
    assert isinstance(ST.get_storage(), S3Storage)
    assert ST.get_storage() is ST.get_storage(), "the selector is memoised"


def test_the_selector_builds_filesystem_when_configured(settings, _fresh_selector, tmp_path):
    settings.STORAGE_BACKEND = "filesystem"
    settings.STORAGE_FS_ROOT = str(tmp_path)
    assert isinstance(ST.get_storage(), FilesystemStorage)


def test_storage_healthy_answers_false_rather_than_raising(settings, _fresh_selector):
    settings.STORAGE_BACKEND = "s3"
    settings.S3_BUCKET = "zenpdf-test"
    store = ST.get_storage()
    store._client = MagicMock()
    store._client.list_buckets.side_effect = ConnectionError("seaweed is down")
    assert ST.storage_healthy() is False

    store._client.list_buckets.side_effect = None
    assert ST.storage_healthy() is True


def test_storage_healthy_is_false_when_the_backend_cannot_even_be_built(monkeypatch):
    monkeypatch.setattr(ST, "get_storage", lambda: (_ for _ in ()).throw(RuntimeError("boom")))
    assert ST.storage_healthy() is False
