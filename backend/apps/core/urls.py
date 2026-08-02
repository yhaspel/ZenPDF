from django.urls import path

from apps.users.views import UnsubscribeView

from .views import (
    AdsTxtView,
    ConfigView,
    GuestClaimView,
    GuestSessionView,
    HealthView,
    ImageUploadView,
    SourceUploadView,
)

urlpatterns = [
    path("config/", ConfigView.as_view(), name="config"),
    # Proxied to the site root by nginx — a crawler will only accept it there.
    path("ads.txt", AdsTxtView.as_view(), name="ads-txt"),
    path("health/", HealthView.as_view(), name="health"),
    # Anonymous access (§21.2, §21.5)
    path("guest/session/", GuestSessionView.as_view(), name="guest-session"),
    path("guest/claim/", GuestClaimView.as_view(), name="guest-claim"),
    # Ephemeral image assets: custom stamps (P3), images/watermarks (P4),
    # signatures (P8) — §13 `uploads/{g|u}/{principal}/{ref}.png`.
    path("uploads/image/", ImageUploadView.as_view(), name="image-upload"),
    # The one-click link in every mail footer (§9B). The token is in the path
    # because RFC 8058 says Gmail POSTs the URL as-is, with a fixed body. No
    # auth: the token in the message is the authority, and somebody who wants
    # out must not have to sign in to get out.
    path("mail/unsubscribe/<str:token>/", UnsubscribeView.as_view(),
         name="unsubscribe"),
    # Conversion sources: office/image/html files awaiting convert_from (P6).
    path("uploads/source/", SourceUploadView.as_view(), name="source-upload"),
]
