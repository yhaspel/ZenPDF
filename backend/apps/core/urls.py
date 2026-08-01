from django.urls import path

from .views import (
    ConfigView,
    GuestClaimView,
    GuestSessionView,
    HealthView,
    ImageUploadView,
)

urlpatterns = [
    path("config/", ConfigView.as_view(), name="config"),
    path("health/", HealthView.as_view(), name="health"),
    # Anonymous access (§21.2, §21.5)
    path("guest/session/", GuestSessionView.as_view(), name="guest-session"),
    path("guest/claim/", GuestClaimView.as_view(), name="guest-claim"),
    # Ephemeral image assets: custom stamps (P3), images/watermarks (P4),
    # signatures (P8) — §13 `uploads/{g|u}/{principal}/{ref}.png`.
    path("uploads/image/", ImageUploadView.as_view(), name="image-upload"),
]
