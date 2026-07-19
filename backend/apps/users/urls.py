from django.urls import path

from .views import MeView, RegisterView, UsageView

urlpatterns = [
    path("register/", RegisterView.as_view(), name="register"),
    path("me/", MeView.as_view(), name="me"),
    path("me/usage/", UsageView.as_view(), name="me-usage"),
]
