"""Development settings — running compose stack with real workers."""
from .base import *  # noqa: F401,F403

DEBUG = True
ALLOWED_HOSTS = ["*"]

# Dev-only convenience: prod refuses to start without a real SECRET_KEY.
SECRET_KEY = SECRET_KEY or "dev-insecure-key"  # noqa: F405

# Permissive CORS in dev; prod locks this down (phase 10).
CORS_ALLOW_ALL_ORIGINS = True

# Object storage uses boto3 against SeaweedFS.
STORAGE_BACKEND = "s3"

# Swagger UI is dev-only (§6).
SPECTACULAR_SETTINGS["SERVE_INCLUDE_SCHEMA"] = False  # noqa: F405
