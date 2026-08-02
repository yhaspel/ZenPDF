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

# The auth throttle is per *IP*, and in dev every request — the developer's
# browser and the whole e2e suite — arrives from one. 10/min is the right
# number in production, where those are different people; here it means the
# eleventh test to register an account fails for a reason that has nothing to
# do with what it was testing. Prod keeps the real rate (`THROTTLE_AUTH`).
REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]["auth"] = config(  # noqa: F405
    "THROTTLE_AUTH", default="200/min",
)
# Same reasoning for the signing ceremony: 20/min is right for one stranger
# signing one document, and wrong for an e2e run that plays every signer from
# one address (phase-08).
REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]["public_sign"] = config(  # noqa: F405
    "THROTTLE_PUBLIC_SIGN", default="200/min",
)
# …and the same for the guest and anonymous windows (phase-09). §16's numbers
# assume one visitor per address; in dev the whole e2e suite — every guest,
# every signer, every tool page — is a single IP, so the fiftieth test fails
# for a reason that has nothing to do with what it asserts. The throttles
# themselves are exercised properly in unit tests with overridden rates, and
# production keeps §16.
REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"].update({  # noqa: F405
    "anon": config("THROTTLE_ANON", default="600/min"),  # noqa: F405
    "guest": config("THROTTLE_GUEST", default="600/min"),  # noqa: F405
    "user": config("THROTTLE_USER", default="600/min"),  # noqa: F405
})

# A wall of JSON in `logs.sh` helps nobody; the correlation ids are still on
# every line, in brackets (§10.4).
LOGGING["handlers"]["console"]["formatter"] = "structured"  # noqa: F405
