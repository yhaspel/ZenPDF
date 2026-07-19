"""Public config + health endpoints (01-architecture.md §6, §16)."""
from django.conf import settings
from django.db import connections
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.pdf_engine.storage import storage_healthy


class ConfigView(APIView):
    """Public runtime config for the SPA: limits, feature flags, ads client id."""

    permission_classes = [AllowAny]
    authentication_classes = []

    @extend_schema(responses=OpenApiTypes.OBJECT, tags=["core"])
    def get(self, request):
        return Response(
            {
                "limits": {
                    "max_upload_mb": settings.MAX_UPLOAD_MB,
                    "user_storage_quota_mb": settings.USER_STORAGE_QUOTA_MB,
                    "max_pages": settings.MAX_PAGES,
                    "version_retention": settings.VERSION_RETENTION,
                    "sign_requests_per_month": settings.SIGN_REQUESTS_PER_MONTH,
                    "ocr_pages_per_month": settings.OCR_PAGES_PER_MONTH,
                    "max_concurrent_jobs": settings.MAX_CONCURRENT_JOBS,
                },
                "features": {
                    "ads_enabled": settings.ADS_ENABLED,
                    "presigned_delivery": settings.PRESIGNED_DELIVERY,
                },
                "ads": {
                    "client_id": settings.ADSENSE_CLIENT_ID if settings.ADS_ENABLED else "",
                },
            }
        )


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
        checks = {
            "db": self._db(),
            "redis": self._redis(),
            "storage": storage_healthy(),
            "gotenberg": self._gotenberg(),
        }
        overall = "ok" if all(checks.values()) else "degraded"
        # DB is the hard dependency for serving requests; 503 only if it is down.
        http_status = 200 if checks["db"] else 503
        return Response({"status": overall, "checks": checks}, status=http_status)
