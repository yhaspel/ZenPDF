"""Test settings — hermetic: eager Celery, filesystem storage, locmem email.

Golden engine tests operate on raw bytes and need no services; API tests run
with CELERY_TASK_ALWAYS_EAGER so a job completes inline (01-architecture.md §18).
"""
import os
import tempfile
from pathlib import Path

from .base import *  # noqa: F401,F403

DEBUG = False

SECRET_KEY = "test-insecure-key-for-hermetic-test-runs"

# Hermetic in-memory DB — tests need no Postgres container (§18).
DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}}

CELERY_TASK_ALWAYS_EAGER = True
CELERY_TASK_EAGER_PROPAGATES = True

# Hermetic cache — throttle buckets and metered-op windows must not need Redis
# to run the suite (§18). Single-process tests, so LocMem is equivalent.
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "zenpdf-test",
    }
}

# Filesystem-backed object storage so tests don't require the storage container.
STORAGE_BACKEND = "filesystem"
STORAGE_FS_ROOT = tempfile.mkdtemp(prefix="zenpdf-test-storage-")

EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"

PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]

# Redis lock is a no-op in eager tests (single process, no real broker needed).
DOC_LOCK_TIMEOUT = 5


def _resolve_signing_cert(configured: str) -> str:
    """Find the development signing certificate outside compose too.

    `SIGNING_CERT_PATH` defaults to `/certs/zenpdf-dev.p12`, which is a Docker
    mount and exists nowhere else. Run the suite in a sandbox or on a CI runner
    without that mount and `test_sign_api.py`, `test_finalize_resume.py` and
    `test_isolation_sweep.py` produce **8 failures and 6 errors that read
    exactly like seal breakage** — the most alarming possible symptom for the
    least interesting possible cause, and one that has been re-diagnosed more
    than once. `up.sh` generates the same certificate into `infra/certs/`, so
    the repo has a copy; this finds it.

    Only ever a *fallback*, and only for tests: an explicit `SIGNING_CERT_PATH`
    always wins, and when neither path exists the compose default is left in
    place so the failure still names `/certs/zenpdf-dev.p12` rather than a
    substitute the reader has never heard of.
    """
    if os.environ.get("SIGNING_CERT_PATH") or Path(configured).exists():
        return configured
    repo_copy = BASE_DIR.parent / "infra" / "certs" / "zenpdf-dev.p12"  # noqa: F405
    return str(repo_copy) if repo_copy.exists() else configured


SIGNING_CERT_PATH = _resolve_signing_cert(SIGNING_CERT_PATH)  # noqa: F405

LOGGING["handlers"]["console"]["formatter"] = "structured"  # noqa: F405
