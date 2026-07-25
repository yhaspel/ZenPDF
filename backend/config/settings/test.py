"""Test settings — hermetic: eager Celery, filesystem storage, locmem email.

Golden engine tests operate on raw bytes and need no services; API tests run
with CELERY_TASK_ALWAYS_EAGER so a job completes inline (01-architecture.md §18).
"""
import tempfile

from .base import *  # noqa: F401,F403

DEBUG = False

SECRET_KEY = "test-insecure-key-for-hermetic-test-runs"

# Hermetic in-memory DB — tests need no Postgres container (§18).
DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}}

CELERY_TASK_ALWAYS_EAGER = True
CELERY_TASK_EAGER_PROPAGATES = True

# Filesystem-backed object storage so tests don't require the storage container.
STORAGE_BACKEND = "filesystem"
STORAGE_FS_ROOT = tempfile.mkdtemp(prefix="zenpdf-test-storage-")

EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"

PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]

# Redis lock is a no-op in eager tests (single process, no real broker needed).
DOC_LOCK_TIMEOUT = 5
