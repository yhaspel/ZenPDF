"""Base settings shared by dev and prod (01-architecture.md §6, §12, §16, §19).

Environment is read via python-decouple. Secrets never have code defaults that
would be unsafe in prod; dev-only conveniences live in dev.py.
"""
from datetime import timedelta
from pathlib import Path

import dj_database_url
from decouple import Csv, config

BASE_DIR = Path(__file__).resolve().parent.parent.parent

# --- Core -------------------------------------------------------------------
# No code default: it is also the JWT signing key. dev/test supply a throwaway
# value; prod raises if the environment does not provide one.
SECRET_KEY = config("SECRET_KEY", default="")
DEBUG = config("DEBUG", default=False, cast=bool)
ALLOWED_HOSTS = config("ALLOWED_HOSTS", default="*", cast=Csv())

FRONTEND_BASE_URL = config("FRONTEND_BASE_URL", default="http://localhost:4200")

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    # Third-party
    "rest_framework",
    "rest_framework_simplejwt.token_blacklist",
    "corsheaders",
    "django_filters",
    "drf_spectacular",
    # Local apps
    "apps.users",
    "apps.core",
    "apps.documents",
    "apps.jobs",
    "apps.pdf_engine",
    "apps.esign",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    # Echoes a lazily-minted X-Guest-Token on the response that created it (§21.2).
    "apps.core.middleware.GuestTokenMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

# --- Database ---------------------------------------------------------------
DATABASES = {
    "default": dj_database_url.parse(
        config("DATABASE_URL", default="postgres://zen:zen@db:5432/zenpdf"),
        conn_max_age=600,
    )
}

# --- Auth -------------------------------------------------------------------
AUTH_USER_MODEL = "users.User"

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
     "OPTIONS": {"min_length": 8}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# --- I18N -------------------------------------------------------------------
LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

# --- Static -----------------------------------------------------------------
STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

# --- DRF --------------------------------------------------------------------
REST_FRAMEWORK = {
    # One authenticator resolves a request to exactly one principal: a User via
    # JWT, or a GuestSession via X-Guest-Token (§21.2).
    "DEFAULT_AUTHENTICATION_CLASSES": (
        "apps.core.authentication.PrincipalAuthentication",
    ),
    # Either principal satisfies the default; account-only endpoints declare
    # IsAccount explicitly and answer 403 `account_required` (§6, §21.3).
    "DEFAULT_PERMISSION_CLASSES": (
        "apps.core.permissions.IsPrincipal",
    ),
    "DEFAULT_PAGINATION_CLASS": "apps.core.pagination.DefaultPagination",
    "PAGE_SIZE": 50,
    "DEFAULT_FILTER_BACKENDS": (
        "django_filters.rest_framework.DjangoFilterBackend",
        "rest_framework.filters.OrderingFilter",
        "rest_framework.filters.SearchFilter",
    ),
    "EXCEPTION_HANDLER": "apps.core.exceptions.zenpdf_exception_handler",
    "DEFAULT_THROTTLE_CLASSES": (
        "apps.core.throttling.BurstAnonThrottle",
        "apps.core.throttling.SustainedUserThrottle",
        "apps.core.throttling.GuestThrottle",
        "apps.core.throttling.GuestIPThrottle",
    ),
    "DEFAULT_THROTTLE_RATES": {
        "anon": config("THROTTLE_ANON", default="30/min"),
        "user": config("THROTTLE_USER", default="120/min"),
        "guest": config("THROTTLE_GUEST", default="40/min"),
        "auth": config("THROTTLE_AUTH", default="10/min"),
        "public_sign": config("THROTTLE_PUBLIC_SIGN", default="20/min"),
        # Image assets (stamps, watermarks, signatures) are small and rare per
        # session, but each one decodes an untrusted file — so the endpoint gets
        # its own scope rather than sharing the general write budget.
        "image_upload": config("THROTTLE_IMAGE_UPLOAD", default="60/hour"),
    },
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "TEST_REQUEST_DEFAULT_FORMAT": "json",
    # Throttle identity = the last X-Forwarded-For hop, i.e. the address our own
    # proxy appended. Without this DRF keys on the whole client-supplied chain,
    # which makes every rate limit trivially bypassable.
    "NUM_PROXIES": config("NUM_PROXIES", default=1, cast=int),
}

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=30),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
    "ROTATE_REFRESH_TOKENS": True,
    "BLACKLIST_AFTER_ROTATION": True,
    "UPDATE_LAST_LOGIN": True,
    "AUTH_HEADER_TYPES": ("Bearer",),
    "USER_ID_FIELD": "id",
    "USER_ID_CLAIM": "user_id",
}

SPECTACULAR_SETTINGS = {
    "TITLE": "ZenPDF API",
    "DESCRIPTION": "Free, ad-supported, multi-user PDF workspace.",
    "VERSION": "0.2.0",
    "SERVE_INCLUDE_SCHEMA": False,
    "COMPONENT_SPLIT_REQUEST": True,
    "SCHEMA_PATH_PREFIX": "/api/",
    "ENUM_NAME_OVERRIDES": {},
}

# --- CORS -------------------------------------------------------------------
CORS_ALLOWED_ORIGINS = config(
    "CORS_ALLOWED_ORIGINS",
    default="http://localhost:4200,http://127.0.0.1:4200",
    cast=Csv(),
)
# The SPA sends the guest credential and must be able to *read* a freshly minted
# one off the response — a cross-origin browser hides unlisted response headers.
CORS_ALLOW_HEADERS = (
    "accept", "accept-encoding", "authorization", "content-type", "dnt",
    "origin", "user-agent", "x-csrftoken", "x-requested-with",
    "x-guest-token", "x-captcha-token",
)
CORS_EXPOSE_HEADERS = ["X-Guest-Token"]

# --- Celery (§12) -----------------------------------------------------------
REDIS_URL = config("REDIS_URL", default="redis://redis:6379/0")
CELERY_BROKER_URL = REDIS_URL
CELERY_RESULT_BACKEND = REDIS_URL
CELERY_TASK_ACKS_LATE = True
CELERY_TASK_REJECT_ON_WORKER_LOST = True
CELERY_WORKER_PREFETCH_MULTIPLIER = 1
CELERY_TASK_TRACK_STARTED = True
CELERY_RESULT_EXPIRES = 3600
CELERY_TASK_DEFAULT_QUEUE = "default"
# type -> queue routing is driven by the operation registry; explicit routes for
# the demo/internal tasks:
CELERY_TASK_ROUTES = {
    "apps.core.tasks.guest_purge": {"queue": "default"},
    "apps.jobs.tasks.noop_sleep": {"queue": "default"},
    "apps.documents.tasks.run_operation": {"queue": "default"},
    "apps.documents.tasks.run_cross_document_operation": {"queue": "heavy"},
    "apps.documents.tasks.generate_thumbnails_task": {"queue": "render"},
}
# Per-queue limits are applied on the worker commands (--time-limit /
# --soft-time-limit, see infra/docker-compose*.yml, §12); these are the fallback
# for a worker started without them. A soft limit raises SoftTimeLimitExceeded
# inside the task, so the job is marked failed instead of hanging forever.
CELERY_TASK_TIME_LIMIT = config("CELERY_TASK_TIME_LIMIT", default=900, cast=int)
CELERY_TASK_SOFT_TIME_LIMIT = config("CELERY_TASK_SOFT_TIME_LIMIT", default=600, cast=int)

# Beat: hard time limits kill the worker process without touching the Job row,
# so a periodic sweep is what actually frees the user's concurrency slots (§11).
CELERY_BEAT_SCHEDULE = {
    "reap-stalled-jobs": {
        "task": "apps.jobs.tasks.reap_stalled_jobs",
        "schedule": 300.0,
    },
    # Expired guest sessions are hard-deleted hourly, rows and blobs (§15, §21.4).
    "guest-purge": {
        "task": "apps.core.tasks.guest_purge",
        "schedule": 3600.0,
    },
    # Export artefacts (`exports/{job_id}/…`) past their TTL — the UI tells the
    # user they are kept for 24 hours, and this is what makes that true (§15).
    "exports-purge": {
        "task": "apps.core.tasks.exports_purge",
        "schedule": 3600.0,
    },
    # Signing nudges and expiries (§15, phase-08). Hourly is often enough for a
    # cadence measured in days, and rare enough that a stuck run is visible.
    "sign-reminders": {
        "task": "apps.esign.tasks.sign_reminders",
        "schedule": 3600.0,
    },
    "sign-expirations": {
        "task": "apps.esign.tasks.sign_expirations",
        "schedule": 3600.0,
    },
}
EXPORT_TTL_HOURS = config("EXPORT_TTL_HOURS", default=24, cast=int)
JOB_STALL_TIMEOUT = config("JOB_STALL_TIMEOUT", default=1800, cast=int)

# --- Cache (§16) ------------------------------------------------------------
# Throttle buckets and the short-window metered-op counters live here. It must
# be Redis, not the per-process LocMem default: with several API workers a
# per-process bucket means each worker enforces its own private rate limit.
# A separate Redis db keeps them off the broker's keyspace.
CACHE_URL = config("CACHE_URL", default=REDIS_URL.rsplit("/", 1)[0] + "/1")
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.redis.RedisCache",
        "LOCATION": CACHE_URL,
        "KEY_PREFIX": "zen",
    }
}

# --- Redis locks (§11) ------------------------------------------------------
DOC_LOCK_TIMEOUT = 120

# --- Email (§15) ------------------------------------------------------------
EMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend"
EMAIL_HOST = config("EMAIL_HOST", default="mailpit")
EMAIL_PORT = config("EMAIL_PORT", default=1025, cast=int)
EMAIL_USE_TLS = config("EMAIL_USE_TLS", default=False, cast=bool)
EMAIL_HOST_USER = config("EMAIL_HOST_USER", default="")
EMAIL_HOST_PASSWORD = config("EMAIL_HOST_PASSWORD", default="")
DEFAULT_FROM_EMAIL = config("DEFAULT_FROM_EMAIL", default="ZenPDF <no-reply@zenpdf.local>")

# --- Object storage (§13) ---------------------------------------------------
S3_ENDPOINT_URL = config("S3_ENDPOINT_URL", default="http://storage:8333")
S3_PUBLIC_ENDPOINT = config("S3_PUBLIC_ENDPOINT", default="http://localhost:8333")
S3_ACCESS_KEY = config("S3_ACCESS_KEY", default="zenpdf")
S3_SECRET_KEY = config("S3_SECRET_KEY", default="zenpdf-secret-dev")
S3_BUCKET = config("S3_BUCKET", default="zenpdf")
S3_REGION = config("S3_REGION", default="us-east-1")
PRESIGNED_DELIVERY = config("PRESIGNED_DELIVERY", default=False, cast=bool)

# --- Engine / signing -------------------------------------------------------
GOTENBERG_URL = config("GOTENBERG_URL", default="http://gotenberg:3000")
# Layer 2 of the SSRF guard (§17, phase-06): the pattern Gotenberg's Chromium
# refuses to navigate to, on *every* navigation — which is what covers the hops
# `apps.core.urlguard` cannot see (a redirect, or a name that resolves publicly
# when we check it and privately when Chromium connects). Compose passes this
# same value to the container; the default here and there are deliberately
# identical so the guard holds even if the env var goes missing.
GOTENBERG_DENY_LIST = config(
    "GOTENBERG_DENY_LIST",
    # No commas: gotenberg's flag parser splits this value on them, which
    # silently truncates the pattern mid-expression.
    default=r"^file:(?!//\/tmp/).*|^[a-z]+://(?:[^/@]*@)?(localhost|127\.\d+(\.\d+)?(\.\d+)?|0\.0\.0\.0|0x[0-9a-f]+|0\d+(\.\d+)?(\.\d+)?(\.\d+)?|\d\d\d\d\d\d\d\d\d?\d?|\[?::1\]?|\[?::ffff:.*|\[?0:0:0:0:0:(0|ffff):.*|\[?fd[0-9a-f][0-9a-f]:.*|\[?fe80:.*|169\.254\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|100\.100\.200\.200|metadata\.google\.internal|metadata\.goog|.*\.internal|api|web|db|redis|storage|mailpit|gotenberg|beat|worker-default|worker-heavy|worker-render)\.?([:/].*)?$",
)
SIGNING_CERT_PATH = config("SIGNING_CERT_PATH", default="/certs/zenpdf-dev.p12")
SIGNING_CERT_PASSWORD = config("SIGNING_CERT_PASSWORD", default="devpass")
TSA_URL = config("TSA_URL", default="")
# The /verify upload cap. Deliberately smaller than a document upload: this
# endpoint is public and unauthenticated, and nothing about checking a seal
# needs a 100 MB file.
VERIFY_MAX_UPLOAD_BYTES = config("VERIFY_MAX_UPLOAD_BYTES", default=30 * 1024 * 1024, cast=int)

# --- Quotas & limits (§16) --------------------------------------------------
MAX_UPLOAD_MB = config("MAX_UPLOAD_MB", default=100, cast=int)
USER_STORAGE_QUOTA_MB = config("USER_STORAGE_QUOTA_MB", default=2048, cast=int)
MAX_PAGES = config("MAX_PAGES", default=2000, cast=int)
VERSION_RETENTION = config("VERSION_RETENTION", default=50, cast=int)
SIGN_REQUESTS_PER_MONTH = config("SIGN_REQUESTS_PER_MONTH", default=30, cast=int)
OCR_PAGES_PER_MONTH = config("OCR_PAGES_PER_MONTH", default=2000, cast=int)
MAX_CONCURRENT_JOBS = config("MAX_CONCURRENT_JOBS", default=3, cast=int)

# --- Anonymous access (§19, §21) --------------------------------------------
GUEST_ACCESS_ENABLED = config("GUEST_ACCESS_ENABLED", default=True, cast=bool)
GUEST_TTL_HOURS = config("GUEST_TTL_HOURS", default=24, cast=int)
GUEST_TTL_MAX_HOURS = config("GUEST_TTL_MAX_HOURS", default=72, cast=int)
GUEST_STORAGE_QUOTA_MB = config("GUEST_STORAGE_QUOTA_MB", default=200, cast=int)
GUEST_MAX_UPLOAD_MB = config("GUEST_MAX_UPLOAD_MB", default=25, cast=int)
GUEST_MAX_PAGES = config("GUEST_MAX_PAGES", default=300, cast=int)
CAPTCHA_ENABLED = config("CAPTCHA_ENABLED", default=False, cast=bool)
TURNSTILE_SITE_KEY = config("TURNSTILE_SITE_KEY", default="")
TURNSTILE_SECRET_KEY = config("TURNSTILE_SECRET_KEY", default="")
TURNSTILE_VERIFY_URL = config(
    "TURNSTILE_VERIFY_URL",
    default="https://challenges.cloudflare.com/turnstile/v0/siteverify",
)
# Salted so a stored hash is not a reversible IP. Rotating this voids the IP leg
# of the guest throttle key for live sessions, so rotate no *faster* than
# GUEST_TTL_MAX_HOURS — by then every stored hash has aged out (§17).
GUEST_IP_HASH_SALT = config("GUEST_IP_HASH_SALT", default="dev-rotate-me")

# --- Tiers (§16) ------------------------------------------------------------
# Limits are tier-resolved, never hardcoded at a call site: every check goes
# through apps.core.limits.for_principal(). The `free` row is driven by the
# existing env knobs (§19 calls them "the free overrides"); `pro` is a config
# row only — no billing, no purchase path, no upgrade UI in v1 (§21.7).
TIERS = {
    "guest": {
        "storage_mb": GUEST_STORAGE_QUOTA_MB,
        "max_upload_mb": GUEST_MAX_UPLOAD_MB,
        "max_image_upload_mb": config("GUEST_MAX_IMAGE_UPLOAD_MB", default=5, cast=int),
        "max_pages": GUEST_MAX_PAGES,
        "max_concurrent_jobs": config("GUEST_MAX_CONCURRENT_JOBS", default=1, cast=int),
        "metered_ops_per_hour": config("GUEST_METERED_OPS_PER_HOUR", default=5, cast=int),
        "ocr_pages_per_day": config("GUEST_OCR_PAGES_PER_DAY", default=50, cast=int),
        "ocr_pages_per_month": 0,
        "sign_requests_per_month": 0,   # 0 ⇒ account_required, not quota_exceeded
        "version_retention": config("GUEST_VERSION_RETENTION", default=10, cast=int),
        "library": False,
        "ads": True,
    },
    "free": {
        "storage_mb": USER_STORAGE_QUOTA_MB,
        "max_upload_mb": MAX_UPLOAD_MB,
        "max_image_upload_mb": config("MAX_IMAGE_UPLOAD_MB", default=10, cast=int),
        "max_pages": MAX_PAGES,
        "max_concurrent_jobs": MAX_CONCURRENT_JOBS,
        "metered_ops_per_hour": config("FREE_METERED_OPS_PER_HOUR", default=40, cast=int),
        "ocr_pages_per_day": 0,          # 0 ⇒ no daily window; the monthly cap applies
        "ocr_pages_per_month": OCR_PAGES_PER_MONTH,
        "sign_requests_per_month": SIGN_REQUESTS_PER_MONTH,
        "version_retention": VERSION_RETENTION,
        "library": True,
        "ads": True,
    },
    "pro": {
        "storage_mb": config("PRO_STORAGE_QUOTA_MB", default=20480, cast=int),
        "max_upload_mb": config("PRO_MAX_UPLOAD_MB", default=500, cast=int),
        "max_image_upload_mb": config("PRO_MAX_IMAGE_UPLOAD_MB", default=25, cast=int),
        "max_pages": config("PRO_MAX_PAGES", default=5000, cast=int),
        "max_concurrent_jobs": config("PRO_MAX_CONCURRENT_JOBS", default=6, cast=int),
        "metered_ops_per_hour": config("PRO_METERED_OPS_PER_HOUR", default=200, cast=int),
        "ocr_pages_per_day": 0,
        "ocr_pages_per_month": config("PRO_OCR_PAGES_PER_MONTH", default=20000, cast=int),
        "sign_requests_per_month": config("PRO_SIGN_REQUESTS_PER_MONTH", default=300, cast=int),
        "version_retention": config("PRO_VERSION_RETENTION", default=200, cast=int),
        "library": True,
        "ads": False,
    },
}

# Allow large multipart uploads to stream to storage (§13). The hard cap is
# enforced in the ingest view against MAX_UPLOAD_MB.
DATA_UPLOAD_MAX_MEMORY_SIZE = 5 * 1024 * 1024  # 5 MB then spill to temp file
FILE_UPLOAD_MAX_MEMORY_SIZE = 5 * 1024 * 1024
DATA_UPLOAD_MAX_NUMBER_FIELDS = 1000

# --- Ads (phase 9) ----------------------------------------------------------
ADS_ENABLED = config("ADS_ENABLED", default=False, cast=bool)
ADSENSE_CLIENT_ID = config("ADSENSE_CLIENT_ID", default="")

# --- Seed -------------------------------------------------------------------
SEED_ADMIN_EMAIL = config("SEED_ADMIN_EMAIL", default="admin@zenpdf.local")
SEED_ADMIN_PASSWORD = config("SEED_ADMIN_PASSWORD", default="admin12345")

# --- Logging (structured console) -------------------------------------------
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "structured": {
            "format": "%(asctime)s %(levelname)s %(name)s %(message)s",
        },
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": "structured",
        },
    },
    "root": {"handlers": ["console"], "level": config("LOG_LEVEL", default="INFO")},
    "loggers": {
        "django.request": {"handlers": ["console"], "level": "ERROR", "propagate": False},
        "zenpdf": {"handlers": ["console"], "level": "INFO", "propagate": False},
    },
}
