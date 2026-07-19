"""Development settings — running compose stack with real workers."""
from .base import *  # noqa: F401,F403

DEBUG = True
ALLOWED_HOSTS = ["*"]

# Permissive CORS in dev; prod locks this down (phase 10).
CORS_ALLOW_ALL_ORIGINS = True

# Object storage uses boto3 against SeaweedFS.
STORAGE_BACKEND = "s3"

# Swagger UI is dev-only (§6).
SPECTACULAR_SETTINGS["SERVE_INCLUDE_SCHEMA"] = False  # noqa: F405
