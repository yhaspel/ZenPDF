"""Object storage client (01-architecture.md §13).

Two backends: `s3` (boto3 → SeaweedFS, path-style) for the running stack and
`filesystem` for hermetic tests. Selected by settings.STORAGE_BACKEND.

Storage keys (§13):
    docs/{document_id}/v{seq}.pdf
    thumbs/{document_id}/{seq}/p{page}@{w}.png
    exports/{job_id}/{filename}
"""
from __future__ import annotations

import os
import shutil
from collections.abc import Iterator
from functools import lru_cache
from typing import BinaryIO

from django.conf import settings

CHUNK = 256 * 1024


class BaseStorage:
    def put_bytes(self, key: str, data: bytes, content_type: str = "application/pdf") -> None:
        raise NotImplementedError

    def put_stream(self, key: str, fileobj: BinaryIO, content_type: str = "application/pdf") -> int:
        raise NotImplementedError

    def get_bytes(self, key: str) -> bytes:
        raise NotImplementedError

    def head(self, key: str) -> dict:
        """Return {'size': int} or raise KeyError if missing."""
        raise NotImplementedError

    def exists(self, key: str) -> bool:
        raise NotImplementedError

    def iter_range(self, key: str, start: int, end: int) -> Iterator[bytes]:
        """Yield bytes for the inclusive byte range [start, end]."""
        raise NotImplementedError

    def delete(self, key: str) -> None:
        raise NotImplementedError

    def list_prefix(self, prefix: str) -> list[str]:
        """Every key under `prefix`.

        `guest_purge` needs it: a document's thumbnails are keyed by page and
        width (`thumbs/{doc}/{seq}/p{n}@{w}.png`), so the exact key set is not
        derivable from the DB rows — deleting only the version blobs would
        orphan them (§21.4).
        """
        raise NotImplementedError

    def delete_prefix(self, prefix: str) -> int:
        """Delete everything under `prefix`; return the number of keys removed."""
        removed = 0
        for key in self.list_prefix(prefix):
            self.delete(key)
            removed += 1
        return removed

    def presigned_get(self, key: str, expires: int = 3600) -> str:
        raise NotImplementedError

    def ensure_bucket(self) -> None:
        raise NotImplementedError

    def healthy(self) -> bool:
        raise NotImplementedError


class S3Storage(BaseStorage):
    def __init__(self):
        import boto3
        from botocore.config import Config

        self._bucket = settings.S3_BUCKET
        cfg = Config(
            s3={"addressing_style": "path"},
            signature_version="s3v4",
            retries={"max_attempts": 3, "mode": "standard"},
        )
        self._client = boto3.client(
            "s3",
            endpoint_url=settings.S3_ENDPOINT_URL,
            aws_access_key_id=settings.S3_ACCESS_KEY,
            aws_secret_access_key=settings.S3_SECRET_KEY,
            region_name=settings.S3_REGION,
            config=cfg,
        )
        self._public_client = boto3.client(
            "s3",
            endpoint_url=settings.S3_PUBLIC_ENDPOINT,
            aws_access_key_id=settings.S3_ACCESS_KEY,
            aws_secret_access_key=settings.S3_SECRET_KEY,
            region_name=settings.S3_REGION,
            config=cfg,
        )

    def put_bytes(self, key, data, content_type="application/pdf"):
        self._client.put_object(Bucket=self._bucket, Key=key, Body=data, ContentType=content_type)

    def put_stream(self, key, fileobj, content_type="application/pdf"):
        # SeaweedFS S3 supports upload_fileobj (multipart under the hood).
        self._client.upload_fileobj(
            fileobj, self._bucket, key, ExtraArgs={"ContentType": content_type}
        )
        return self.head(key)["size"]

    def get_bytes(self, key):
        obj = self._client.get_object(Bucket=self._bucket, Key=key)
        return obj["Body"].read()

    def head(self, key):
        from botocore.exceptions import ClientError

        try:
            obj = self._client.head_object(Bucket=self._bucket, Key=key)
        except ClientError as exc:  # noqa: BLE001
            raise KeyError(key) from exc
        return {"size": int(obj["ContentLength"])}

    def exists(self, key):
        try:
            self.head(key)
            return True
        except KeyError:
            return False

    def iter_range(self, key, start, end):
        obj = self._client.get_object(
            Bucket=self._bucket, Key=key, Range=f"bytes={start}-{end}"
        )
        body = obj["Body"]
        while True:
            chunk = body.read(CHUNK)
            if not chunk:
                break
            yield chunk

    def delete(self, key):
        self._client.delete_object(Bucket=self._bucket, Key=key)

    def list_prefix(self, prefix):
        keys = []
        paginator = self._client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self._bucket, Prefix=prefix):
            keys.extend(obj["Key"] for obj in page.get("Contents", []))
        return keys

    def presigned_get(self, key, expires=3600):
        return self._public_client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self._bucket, "Key": key},
            ExpiresIn=expires,
        )

    def ensure_bucket(self):
        from botocore.exceptions import ClientError

        try:
            self._client.head_bucket(Bucket=self._bucket)
        except ClientError:
            self._client.create_bucket(Bucket=self._bucket)

    def healthy(self):
        try:
            self._client.list_buckets()
            return True
        except Exception:  # noqa: BLE001
            return False


class FilesystemStorage(BaseStorage):
    def __init__(self):
        self._root = getattr(settings, "STORAGE_FS_ROOT", "/tmp/zenpdf-storage")
        os.makedirs(self._root, exist_ok=True)

    def _path(self, key: str) -> str:
        return os.path.join(self._root, key)

    def put_bytes(self, key, data, content_type="application/pdf"):
        path = self._path(key)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(data)

    def put_stream(self, key, fileobj, content_type="application/pdf"):
        path = self._path(key)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        size = 0
        with open(path, "wb") as fh:
            for chunk in iter(lambda: fileobj.read(CHUNK), b""):
                fh.write(chunk)
                size += len(chunk)
        return size

    def get_bytes(self, key):
        with open(self._path(key), "rb") as fh:
            return fh.read()

    def head(self, key):
        path = self._path(key)
        if not os.path.exists(path):
            raise KeyError(key)
        return {"size": os.path.getsize(path)}

    def exists(self, key):
        return os.path.exists(self._path(key))

    def iter_range(self, key, start, end):
        with open(self._path(key), "rb") as fh:
            fh.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = fh.read(min(CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    def delete(self, key):
        path = self._path(key)
        if os.path.exists(path):
            os.remove(path)

    def list_prefix(self, prefix):
        keys = []
        for dirpath, _dirnames, filenames in os.walk(self._root):
            for name in filenames:
                key = os.path.relpath(os.path.join(dirpath, name), self._root)
                if key.startswith(prefix):
                    keys.append(key)
        return keys

    def presigned_get(self, key, expires=3600):
        # Filesystem backend has no presign; callers must use the API proxy.
        raise NotImplementedError("presigned delivery unavailable on filesystem backend")

    def ensure_bucket(self):
        os.makedirs(self._root, exist_ok=True)

    def healthy(self):
        return os.path.isdir(self._root)

    def _reset(self):  # test helper
        shutil.rmtree(self._root, ignore_errors=True)
        os.makedirs(self._root, exist_ok=True)


@lru_cache(maxsize=1)
def get_storage() -> BaseStorage:
    backend = getattr(settings, "STORAGE_BACKEND", "s3")
    if backend == "filesystem":
        return FilesystemStorage()
    return S3Storage()


def storage_healthy() -> bool:
    try:
        return get_storage().healthy()
    except Exception:  # noqa: BLE001
        return False
