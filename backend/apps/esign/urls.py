"""E-signature routes (phase-08).

Two prefixes with different rules, kept visibly apart so nobody has to read a
view to know which is which: `/api/signatures/` and `/api/sign-requests/` are
account-only, `/api/public/sign/…` and `/api/verify/` are open to anyone.
"""
from django.urls import path

from . import views

urlpatterns = [
    # 8A — signatures. `render/` is deliberately public: it is how a guest
    # previews a typed signature, and it stores nothing.
    path("signatures/", views.SignatureListView.as_view(), name="signature-list"),
    path("signatures/render/", views.SignatureRenderView.as_view(),
         name="signature-render"),
    path("signatures/<uuid:pk>/", views.SignatureDetailView.as_view(),
         name="signature-detail"),
    path("signatures/<uuid:pk>/image/", views.SignatureImageView.as_view(),
         name="signature-image"),

    # 8B — requests (account-only)
    path("sign-requests/", views.SignRequestListView.as_view(),
         name="sign-request-list"),
    path("sign-requests/<uuid:pk>/", views.SignRequestDetailView.as_view(),
         name="sign-request-detail"),
    path("sign-requests/<uuid:pk>/send/", views.SignRequestSendView.as_view(),
         name="sign-request-send"),
    path("sign-requests/<uuid:pk>/cancel/", views.SignRequestCancelView.as_view(),
         name="sign-request-cancel"),
    path("sign-requests/<uuid:pk>/remind/", views.SignRequestRemindView.as_view(),
         name="sign-request-remind"),
    path("sign-requests/<uuid:pk>/audit/", views.SignRequestAuditView.as_view(),
         name="sign-request-audit"),
    path("sign-requests/<uuid:pk>/download/<str:what>/",
         views.SignRequestDownloadView.as_view(), name="sign-request-download"),

    # The ceremony — no auth anywhere below this line
    path("public/sign/disclosure/", views.PublicSignDisclosureView.as_view(),
         name="public-sign-disclosure"),
    path("public/sign/<str:token>/", views.PublicSignDetailView.as_view(),
         name="public-sign-detail"),
    path("public/sign/<str:token>/content/", views.PublicSignContentView.as_view(),
         name="public-sign-content"),
    path("public/sign/<str:token>/pages/<int:page>/",
         views.PublicSignPageView.as_view(), name="public-sign-page"),
    path("public/sign/<str:token>/consent/", views.PublicSignConsentView.as_view(),
         name="public-sign-consent"),
    path("public/sign/<str:token>/fields/", views.PublicSignFieldView.as_view(),
         name="public-sign-fields"),
    path("public/sign/<str:token>/complete/", views.PublicSignCompleteView.as_view(),
         name="public-sign-complete"),
    path("public/sign/<str:token>/decline/", views.PublicSignDeclineView.as_view(),
         name="public-sign-decline"),
    path("public/sign/<str:token>/report/", views.PublicSignReportView.as_view(),
         name="public-sign-report"),
    path("public/sign/<str:token>/download/<str:what>/",
         views.PublicSignDownloadView.as_view(), name="public-sign-download"),

    # 8C — verification, public and ad-free
    path("verify/", views.VerifyView.as_view(), name="verify"),
]
