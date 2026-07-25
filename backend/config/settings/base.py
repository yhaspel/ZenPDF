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
    "DEFAULT_AUTHENTICATION_CLASSES": (
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ),
    "DEFAULT_PERMISSION_CLASSES": (
        "rest_framework.permissions.IsAuthenticated",
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
    ),
    "DEFAULT_THROTTLE_RATES": {
        "anon": config("THROTTLE_ANON", default="30/min"),
        "user": config("THROTTLE_USER", default="120/min"),
        "auth": config("THROTTLE_AUTH", default="10/min"),
        "public_sign": config("THROTTLE_PUBLIC_SIGN", default="20/min"),
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
}
JOB_STALL_TIMEOUT = config("JOB_STALL_TIMEOUT", default=1800, cast=int)

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
SIGNING_CERT_PATH = config("SIGNING_CERT_PATH", default="/certs/zenpdf-dev.p12")
SIGNING_CERT_PASSWORD = config("SIGNING_CERT_PASSWORD", default="devpass")
TSA_URL = config("TSA_URL", default="")

# --- Quotas & limits (§16) --------------------------------------------------
MAX_UPLOAD_MB = config("MAX_UPLOAD_MB", default=100, cast=int)
USER_STORAGE_QUOTA_MB = config("USER_STORAGE_QUOTA_MB", default=2048, cast=int)
MAX_PAGES = config("MAX_PAGES", default=2000, cast=int)
VERSION_RETENTION = config("VERSION_RETENTION", default=50, cast=int)
SIGN_REQUESTS_PER_MONTH = config("SIGN_REQUESTS_PER_MONTH", default=30, cast=int)
OCR_PAGES_PER_MONTH = config("OCR_PAGES_PER_MONTH", default=2000, cast=int)
MAX_CONCURRENT_JOBS = config("MAX_CONCURRENT_JOBS", default=3, cast=int)

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
