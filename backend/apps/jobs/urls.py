from django.urls import path

from .views import (
    DemoJobView,
    JobCancelView,
    JobDetailView,
    JobDownloadView,
    JobListView,
)

urlpatterns = [
    path("", JobListView.as_view(), name="job-list"),
    path("demo/", DemoJobView.as_view(), name="job-demo"),
    path("<uuid:pk>/", JobDetailView.as_view(), name="job-detail"),
    path("<uuid:pk>/cancel/", JobCancelView.as_view(), name="job-cancel"),
    # Export download (§15, phase-06): `exports/{job_id}/…`, 24 h TTL.
    path("<uuid:pk>/download/", JobDownloadView.as_view(), name="job-download"),
]
