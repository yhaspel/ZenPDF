"""Production settings — gunicorn behind nginx. Hardening completed in phase 10."""
from .base import *  # noqa: F401,F403

DEBUG = False

STORAGE_BACKEND = "s3"

# Security headers (nginx adds CSP in phase 10).
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
X_FRAME_OPTIONS = "DENY"

# Admin site is disabled/IP-gated in prod (§17); left enabled here until phase 10.
