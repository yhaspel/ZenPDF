from django.urls import path

from .views import ConfigView, GuestClaimView, GuestSessionView, HealthView

urlpatterns = [
    path("config/", ConfigView.as_view(), name="config"),
    path("health/", HealthView.as_view(), name="health"),
    # Anonymous access (§21.2, §21.5)
    path("guest/session/", GuestSessionView.as_view(), name="guest-session"),
    path("guest/claim/", GuestClaimView.as_view(), name="guest-claim"),
]
