"""Storage backends — S3 via mocked boto3 client, filesystem directly."""
import io
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from apps.pdf_engine.storage import FilesystemStorage, S3Storage


def test_filesystem_storage_roundtrip(settings, tmp_path):
    settings.STORAGE_BACKEND = "filesystem"
    settings.STORAGE_FS_ROOT = str(tmp_path)
    st = FilesystemStorage()
    st.put_bytes("a/b.pdf", b"hello")
    assert st.exists("a/b.pdf")
    assert st.head("a/b.pdf") == {"size": 5}
    assert st.get_bytes("a/b.pdf") == b"hello"
    assert b"".join(st.iter_range("a/b.pdf", 1, 3)) == b"ell"
    assert st.put_stream("c.pdf", io.BytesIO(b"xyz")) == 3
    st.delete("c.pdf")
    assert not st.exists("c.pdf")
    st.ensure_bucket()
    assert st.healthy() is True
    with pytest.raises(KeyError):
        st.head("missing")
    with pytest.raises(NotImplementedError):
        st.presigned_get("x")


@pytest.fixture
def s3(settings):
    settings.STORAGE_BACKEND = "s3"
    st = S3Storage()
    st._client = MagicMock()
    st._public_client = MagicMock()
    return st


def test_s3_put_and_head(s3):
    s3.put_bytes("k", b"data")
    s3._client.put_object.assert_called_once()
    s3._client.head_object.return_value = {"ContentLength": 4}
    assert s3.head("k") == {"size": 4}
    assert s3.exists("k") is True


def test_s3_get_and_range(s3):
    body = MagicMock()
    body.read.return_value = b"data"
    s3._client.get_object.return_value = {"Body": body}
    assert s3.get_bytes("k") == b"data"

    body2 = MagicMock()
    body2.read.side_effect = [b"da", b"ta", b""]
    s3._client.get_object.return_value = {"Body": body2}
    assert b"".join(s3.iter_range("k", 0, 3)) == b"data"


def test_s3_missing_head_raises_keyerror(s3):
    s3._client.head_object.side_effect = ClientError({"Error": {}}, "HeadObject")
    with pytest.raises(KeyError):
        s3.head("missing")
    assert s3.exists("missing") is False


def test_s3_ensure_bucket_creates_when_absent(s3):
    s3._client.head_bucket.side_effect = ClientError({"Error": {}}, "HeadBucket")
    s3.ensure_bucket()
    s3._client.create_bucket.assert_called_once()


def test_s3_presigned_and_health(s3):
    s3._public_client.generate_presigned_url.return_value = "http://signed"
    assert s3.presigned_get("k") == "http://signed"
    s3._client.list_buckets.return_value = {}
    assert s3.healthy() is True
    s3._client.list_buckets.side_effect = Exception("down")
    assert s3.healthy() is False


def test_s3_put_stream(s3):
    s3._client.head_object.return_value = {"ContentLength": 9}
    assert s3.put_stream("k", io.BytesIO(b"123456789")) == 9
