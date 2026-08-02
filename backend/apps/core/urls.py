from django.urls import path

from apps.users.views import UnsubscribeView

from .views import (
    ConfigView,
    GuestClaimView,
    GuestSessionView,
    HealthView,
    ImageUploadView,
    SourceUploadView,
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
    # The one-click link in every mail footer (§9B). No auth: the token in the
    # message is the authority, and somebody who wants out must not have to
    # sign in to get out.
    path("mail/unsubscribe/", UnsubscribeView.as_view(), name="unsubscribe"),
    # Conversion sources: office/image/html files awaiting convert_from (P6).
    path("uploads/source/", SourceUploadView.as_view(), name="source-upload"),
]
