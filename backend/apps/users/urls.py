from django.urls import path

from .views import (
    MeView,
    RegisterView,
    SendVerificationView,
    UsageView,
    VerifyEmailView,
)

urlpatterns = [
    path("register/", RegisterView.as_view(), name="register"),
    path("me/", MeView.as_view(), name="me"),
    path("me/usage/", UsageView.as_view(), name="me-usage"),
    # Email verification (§9B). Gates *sending for signature*, never uploading.
    path("verify/send/", SendVerificationView.as_view(), name="verify-send"),
    path("verify/", VerifyEmailView.as_view(), name="verify-email"),
]
