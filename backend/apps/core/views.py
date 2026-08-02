"""Public config + health + guest-session endpoints (§6, §16, §21)."""
from django.conf import settings
from django.db import connections
from django.http import HttpResponse
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.pdf_engine.exceptions import EngineError
from apps.pdf_engine.storage import storage_healthy

from . import limits as L
from .assets import AssetQuotaExceeded, ImageRejected, store_image, store_source
from .authentication import require_principal
from .claim import claim_session
from .exceptions import (
    AccountRequired,
    FileTooLarge,
    GuestExpired,
    QuotaExceeded,
    ValidationFailed,
)
from .models import GuestSession
from .permissions import IsAccount
from .principals import is_guest, label


def guest_state(principal) -> dict:
    """Session shape shared by `/api/guest/session/` and `/api/config/`."""
    if not is_guest(principal):
        return {}
    return {
        "id": str(principal.id),
        "expires_at": principal.expires_at.isoformat(),
        "seconds_remaining": max(
            0, int((principal.expires_at - timezone.now()).total_seconds())
        ),
        "storage_bytes_used": principal.storage_bytes_used,
    }


class AdsTxtView(APIView):
    """`/ads.txt` — IAB Authorized Digital Sellers, rendered from config (§9A).

    Served by the API rather than baked into the frontend image, because the
    only thing in it is the publisher id, and that lives in the environment.
    Until an AdSense account exists the file is deliberately empty of sellers:
    a valid, considered answer beats a 404, and the day the id arrives one
    variable changes with no rebuild.
    """

    permission_classes = [AllowAny]
    authentication_classes: list = []

    @extend_schema(responses=OpenApiTypes.STR, tags=["core"])
    def get(self, request):
        lines = [
            "# ads.txt — Authorized Digital Sellers (IAB).",
            "# Rendered from ADSENSE_CLIENT_ID; see docs/09-adsense-readiness.md.",
        ]
        client = (settings.ADSENSE_CLIENT_ID or "").strip()
        if client and settings.ADS_PROVIDER == "adsense":
            # `pub-…` is what AdSense issues; the certification id below is
            # Google's own, fixed for every AdSense publisher.
            publisher = client.removeprefix("ca-")
            lines.append(f"google.com, {publisher}, DIRECT, f08c47fec0942fa0")
        else:
            lines.append("# No sellers are authorised yet.")
        return HttpResponse("\n".join(lines) + "\n", content_type="text/plain")


class ConfigView(APIView):
    """Runtime config for the SPA — **the current principal's** tier limits.

    Public, but no longer principal-blind: the client can pre-empt a rejection
    instead of discovering it at 429 (§16). An anonymous caller is quoted guest
    limits, which is what it will get the moment it writes anything.
    """

    permission_classes = [AllowAny]

    @extend_schema(responses=OpenApiTypes.OBJECT, tags=["core"])
    def get(self, request):
        principal = require_principal(request)  # never mints on a read (§21.2)
        tier = L.for_principal(principal)
        return Response(
            {
                "principal": label(principal),
                "limits": tier.as_api_dict(),
                "guest": guest_state(principal),
                "features": {
                    "ads_enabled": settings.ADS_ENABLED,
                    "presigned_delivery": settings.PRESIGNED_DELIVERY,
                    "guest_access_enabled": settings.GUEST_ACCESS_ENABLED,
                    "captcha_enabled": settings.CAPTCHA_ENABLED,
                },
                "guest_ttl_hours": settings.GUEST_TTL_HOURS,
                "turnstile_site_key": (
                    settings.TURNSTILE_SITE_KEY if settings.CAPTCHA_ENABLED else ""
                ),
                # Everything the ad layer needs, resolved server-side. When
                # ads are off this is `{enabled: false}` and *nothing else* —
                # no client id, no slot ids, no provider name — so a build with
                # the flag off cannot accidentally load anything (§9A).
                "ads": (
                    {
                        "enabled": True,
                        "provider": settings.ADS_PROVIDER,
                        "client_id": settings.ADSENSE_CLIENT_ID,
                        "slots": {name: unit
                                  for name, unit in settings.ADS_SLOTS.items() if unit},
                    }
                    if settings.ADS_ENABLED else {"enabled": False}
                ),
                # Where a consent banner is legally required. The client sends
                # its region on the query string when it knows one; the rule
                # lives here so it is one list rather than a regex in a
                # component (§9A).
                "consent_required": _consent_required(request),
                "retention": {
                    "guest_hours": settings.GUEST_TTL_HOURS,
                    "trash_days": settings.TRASH_RETENTION_DAYS,
                    "export_hours": settings.EXPORT_TTL_HOURS,
                },
            }
        )


def _consent_required(request) -> bool:
    """Whether this visitor must be asked before any ad code loads.

    The browser knows its own region and we do not want to geolocate an IP for
    this, so the client tells us (`?region=DE`) and the decision is made here
    against one configured list.

    **No region at all → ask.** A browser reporting only "en" is common, and a
    banner shown to somebody who did not need it costs a little revenue, while
    one skipped for somebody who did is a compliance failure. A region that *is*
    stated and is not on the list is taken at its word — the alternative is
    asking the entire world.
    """
    if not settings.ADS_ENABLED:
        return False
    region = (request.query_params.get("region") or "").strip().upper()
    if not region:
        return True
    return region in {r.strip().upper() for r in settings.CONSENT_REQUIRED_REGIONS}


class GuestSessionView(APIView):
    """`POST /api/guest/session/` — mint, or inspect the current session (§21.2).

    Minting is normally lazy (first write). This endpoint exists so a client can
    mint explicitly; it is still a POST, never a side effect of a page view.
    """

    permission_classes = [AllowAny]

    @extend_schema(request=None, responses=OpenApiTypes.OBJECT, tags=["guest"])
    def post(self, request):
        if not settings.GUEST_ACCESS_ENABLED:
            raise AccountRequired("Guest access is currently disabled.")
        existing = getattr(request, "guest_session", None)
        if existing is not None:
            principal = existing
            code = status.HTTP_200_OK
        else:
            principal = require_principal(request, mint=True)
            code = status.HTTP_201_CREATED
        return Response(
            {
                **guest_state(principal),
                "limits": L.for_principal(principal).as_api_dict(),
            },
            status=code,
        )


class GuestClaimView(APIView):
    """`POST /api/guest/claim/` — transfer this guest token's work to the
    authenticated account (§21.5).

    The token travels in `X-Guest-Token` alongside the JWT: this is the one
    request that legitimately carries both credentials.
    """

    permission_classes = [IsAccount]
    account_required_message = "Sign in to claim these files."

    @extend_schema(request=None, responses=OpenApiTypes.OBJECT, tags=["guest"])
    def post(self, request):
        # This is the one request that legitimately carries both credentials.
        # PrincipalAuthentication tries the JWT first, so `request.principal` is
        # the account; the guest token is read straight off the header.
        from .authentication import raw_guest_token

        token = raw_guest_token(request)
        if not token:
            raise GuestExpired("No guest session to claim.")
        session = GuestSession.resolve(token)
        if session is None:
            raise GuestExpired()
        summary = claim_session(session, request.user)
        return Response({"claimed": summary}, status=status.HTTP_200_OK)


class ImageUploadView(APIView):
    """`POST /api/uploads/image/` — an ephemeral image asset (§13 `uploads/…`).

    Guest-accessible: a custom stamp is exactly the kind of file-in/file-out work
    §21.1 says must never need an account. The returned `ref` is opaque and the
    storage key is derived from the *caller's* principal, so a ref can never
    address another principal's asset.
    """

    throttle_scope = "image_upload"

    @extend_schema(request=OpenApiTypes.OBJECT, responses=OpenApiTypes.OBJECT, tags=["core"])
    def post(self, request):
        upload = request.FILES.get("file")
        if upload is None:
            raise ValidationFailed("No file was uploaded (field 'file').")
        # Uploading is a write, so this is a legitimate mint point (§21.2).
        principal = require_principal(request, mint=True)
        if principal is None:
            raise AccountRequired("Guest access is disabled; sign in to upload.")
        tier = L.for_principal(principal)
        if upload.size > tier.max_image_upload_bytes:
            exc = FileTooLarge(
                f"Images must be {tier.max_image_upload_bytes // (1024 * 1024)} MB or smaller."
                + (" Create a free account to upload larger images."
                   if is_guest(principal) else "")
            )
            exc.zen_details = {
                "max_image_upload_bytes": tier.max_image_upload_bytes, "tier": tier.tier,
            }
            raise exc
        try:
            asset = store_image(principal, upload.read())
        except AssetQuotaExceeded as exc:
            quota = QuotaExceeded(
                str(exc) + (" Create a free account for more storage."
                            if is_guest(principal) else "")
            )
            quota.zen_details = {"quota_bytes": exc.quota, "used_bytes": exc.used,
                                 "tier": tier.tier}
            raise quota from exc
        except ImageRejected as exc:
            raise ValidationFailed(str(exc)) from exc
        return Response(asset, status=status.HTTP_201_CREATED)

    def get_throttles(self):
        """Scoped rate **in addition to** the project defaults.

        Setting `throttle_classes` would have *replaced* them, quietly dropping
        `GuestThrottle`/`GuestIPThrottle` on a guest-reachable write endpoint —
        the per-token and per-IP limits §16 says must always apply.
        """
        return [*super().get_throttles(), ScopedRateThrottle()]


class SourceUploadView(APIView):
    """`POST /api/uploads/source/` — a file waiting to be converted (phase-06).

    The other half of "import UX is unified with upload": the dashboard dropzone
    accepts a .docx or a .tiff, parks it here, and runs `convert_from` against
    the ref. Guest-accessible for the same reason the image upload is —
    Word-to-PDF is the archetypal no-account tool.
    """

    throttle_scope = "image_upload"

    @extend_schema(request=OpenApiTypes.OBJECT, responses=OpenApiTypes.OBJECT, tags=["core"])
    def post(self, request):
        upload = request.FILES.get("file")
        if upload is None:
            raise ValidationFailed("No file was uploaded (field 'file').")
        principal = require_principal(request, mint=True)
        if principal is None:
            raise AccountRequired("Guest access is disabled; sign in to upload.")
        tier = L.for_principal(principal)
        if upload.size > tier.max_upload_bytes:
            exc = FileTooLarge(
                f"Files must be {tier.max_upload_bytes // (1024 * 1024)} MB or smaller."
                + (" Create a free account to upload larger files."
                   if is_guest(principal) else "")
            )
            exc.zen_details = {"max_upload_bytes": tier.max_upload_bytes, "tier": tier.tier}
            raise exc
        try:
            asset = store_source(principal, upload.read(), upload.name or "file")
        except AssetQuotaExceeded as exc:
            quota = QuotaExceeded(
                str(exc) + (" Create a free account for more storage."
                            if is_guest(principal) else "")
            )
            quota.zen_details = {"quota_bytes": exc.quota, "used_bytes": exc.used,
                                 "tier": tier.tier}
            raise quota from exc
        except (ImageRejected, EngineError) as exc:
            raise ValidationFailed(str(exc)) from exc
        return Response(asset, status=status.HTTP_201_CREATED)

    def get_throttles(self):
        return [*super().get_throttles(), ScopedRateThrottle()]


class HealthView(APIView):
    """Liveness/readiness — checks db, redis, storage, gotenberg (used by up.sh)."""

    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = []

    def _db(self) -> bool:
        try:
            with connections["default"].cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchone()
            return True
        except Exception:  # noqa: BLE001
            return False

    def _redis(self) -> bool:
        try:
            import redis

            client = redis.from_url(settings.REDIS_URL, socket_connect_timeout=1)
            return bool(client.ping())
        except Exception:  # noqa: BLE001
            return False

    def _gotenberg(self) -> bool:
        try:
            import requests

            resp = requests.get(f"{settings.GOTENBERG_URL}/health", timeout=2)
            return resp.ok
        except Exception:  # noqa: BLE001
            return False

    @extend_schema(responses=OpenApiTypes.OBJECT, tags=["core"])
    def get(self, request):
        from .tasks import (
            HEARTBEAT_STALE_SECONDS,
            heartbeat_age_seconds,
            heartbeat_ages,
            queue_depths,
        )

        try:
            age = heartbeat_age_seconds()
        except Exception:  # noqa: BLE001
            # The heartbeat lives in the cache, which is Redis. A readiness
            # probe that *raises* when Redis is down tells the platform
            # nothing — least of all that the database is fine and the site
            # can keep serving documents.
            age = None
        checks = {
            "db": self._db(),
            "redis": self._redis(),
            "storage": storage_healthy(),
            "gotenberg": self._gotenberg(),
            # A green stack whose workers are dead looks identical to a healthy
            # one from the outside: requests succeed, jobs queue, nothing runs.
            "workers": age is not None and age < HEARTBEAT_STALE_SECONDS,
        }
        overall = "ok" if all(checks.values()) else "degraded"
        # DB is the hard dependency for *serving*; 503 only if it is down. A
        # dead worker is an alert, not a reason to take the site out of the
        # load balancer — people can still read their documents.
        http_status = 200 if checks["db"] else 503
        body = {"status": overall, "checks": checks}
        try:
            body["queues"] = queue_depths()
            body["worker_heartbeat_age_seconds"] = (
                None if age is None else round(age, 1))
            # Per lane, so "which worker died" is answered by the probe rather
            # than by reading three sets of container logs.
            body["workers"] = {
                queue: (None if lane_age is None else round(lane_age, 1))
                for queue, lane_age in heartbeat_ages().items()
            }
        except Exception:  # noqa: BLE001 - the redis check above already said so
            pass
        return Response(body, status=http_status)


class LivenessView(APIView):
    """`/api/health/live` — is this process able to answer at all?

    Deliberately dependency-free: a liveness probe that checks the database
    restarts the API every time Postgres hiccups, which turns one outage into
    two. Readiness (`/api/health/`) is the one that looks outward.
    """

    permission_classes = [AllowAny]
    authentication_classes: list = []
    throttle_classes: list = []

    @extend_schema(responses=OpenApiTypes.OBJECT, tags=["core"])
    def get(self, request):
        return Response({"status": "ok"})
