"""Top-level URL map (01-architecture.md §6)."""
from django.conf import settings
from django.contrib import admin
from django.urls import include, path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView

from apps.users.views import (
    LogoutView,
    ThrottledTokenObtainPairView,
    ThrottledTokenRefreshView,
)

urlpatterns = [
    # Auth (skill convention; login by email via USERNAME_FIELD; §16 auth throttle).
    path("api/auth/login/", ThrottledTokenObtainPairView.as_view(), name="token_obtain_pair"),
    path("api/auth/refresh/", ThrottledTokenRefreshView.as_view(), name="token_refresh"),
    path("api/auth/logout/", LogoutView.as_view(), name="token_logout"),
    # Apps
    path("api/", include("apps.core.urls")),
    path("api/users/", include("apps.users.urls")),
    path("api/", include("apps.documents.urls")),
    path("api/jobs/", include("apps.jobs.urls")),
    path("api/", include("apps.esign.urls")),
    # OpenAPI schema + docs (docs UI dev-only, §6).
    path("api/schema/", SpectacularAPIView.as_view(), name="schema"),
]

if settings.DEBUG:
    urlpatterns += [
        path(
            "api/docs/",
            SpectacularSwaggerView.as_view(url_name="schema"),
            name="swagger-ui",
        ),
        path("admin/", admin.site.urls),
    ]
