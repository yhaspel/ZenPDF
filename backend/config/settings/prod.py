"""Production settings — gunicorn behind nginx. Hardening completed in phase 10."""
from django.core.exceptions import ImproperlyConfigured

from .base import *  # noqa: F401,F403

DEBUG = False

# SECRET_KEY also signs every JWT — a missing one must fail loudly, not fall
# back to a value that is public in the repository.
if not SECRET_KEY:  # noqa: F405
    raise ImproperlyConfigured("SECRET_KEY must be set in the environment.")

STORAGE_BACKEND = "s3"

# Security headers (nginx adds CSP in phase 10).
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
X_FRAME_OPTIONS = "DENY"

# Admin is off unless the deployment sets ADMIN_ENABLED *and* an allowlist —
# the moderation tools are needed in production, an open admin login is not
# (§17). `AdminIPAllowlistMiddleware` enforces it; an empty allowlist denies.

# HSTS is also set at nginx, but Django sets it too: a deployment that puts
# gunicorn behind a different proxy should not silently lose it.
SECURE_HSTS_SECONDS = config("SECURE_HSTS_SECONDS", default=63072000, cast=int)  # noqa: F405
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
# `preload` is a one-way door for the whole domain — the owner opts in.
SECURE_HSTS_PRELOAD = config("SECURE_HSTS_PRELOAD", default=False, cast=bool)  # noqa: F405
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = config("SECURE_SSL_REDIRECT", default=True, cast=bool)  # noqa: F405
# The health endpoints are hit by the platform over plain HTTP inside the
# private network; redirecting them to https breaks every probe.
SECURE_REDIRECT_EXEMPT = [r"^api/health/"]
