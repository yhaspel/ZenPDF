from django.urls import path

from .views import (
    DeleteAccountView,
    ExportView,
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
    # The two privacy obligations the legal pages state (§10.1).
    path("me/export/", ExportView.as_view(), name="me-export"),
    path("me/delete/", DeleteAccountView.as_view(), name="me-delete"),
    # Email verification (§9B). Gates *sending for signature*, never uploading.
    path("verify/send/", SendVerificationView.as_view(), name="verify-send"),
    path("verify/", VerifyEmailView.as_view(), name="verify-email"),
]
