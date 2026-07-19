from django.conf import settings
from drf_spectacular.utils import extend_schema
from rest_framework import generics, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Job
from .serializers import JobSerializer


class JobListView(generics.ListAPIView):
    """List the caller's jobs; filter by `status` and `document` (§9)."""

    serializer_class = JobSerializer
    permission_classes = [IsAuthenticated]
    filterset_fields = ["status", "document", "type"]
    ordering_fields = ["created_at", "finished_at"]

    def get_queryset(self):
        return Job.objects.filter(user=self.request.user)


class JobDetailView(generics.RetrieveAPIView):
    serializer_class = JobSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        # User-scoped → others' jobs 404 (cross-user isolation).
        return Job.objects.filter(user=self.request.user)


class JobCancelView(APIView):
    """Cancel a job — revokes the task if still queued (§11)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses=JobSerializer, tags=["jobs"])
    def post(self, request, pk):
        job = generics.get_object_or_404(Job.objects.filter(user=request.user), pk=pk)
        if job.status == Job.Status.QUEUED:
            if job.celery_task_id:
                try:
                    from config.celery import app as celery_app

                    celery_app.control.revoke(job.celery_task_id)
                except Exception:  # noqa: BLE001
                    pass
            job.mark_canceled()
        elif job.status == Job.Status.RUNNING:
            # Cooperative cancel: long tasks check status between steps.
            job.mark_canceled()
        return Response(JobSerializer(job).data, status=status.HTTP_200_OK)


class DemoJobView(APIView):
    """Enqueue a noop job — phase-0 pipeline smoke test / dashboard dev button."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=None, responses=JobSerializer, tags=["jobs"])
    def post(self, request):
        # Dev/e2e/test only — never a public prod endpoint.
        eager = getattr(settings, "CELERY_TASK_ALWAYS_EAGER", False)
        if not (settings.DEBUG or eager):
            return Response(
                {"error": {"code": "not_found", "message": "Not available.", "details": {}}},
                status=status.HTTP_404_NOT_FOUND,
            )
        job = Job.objects.create(user=request.user, type="noop_sleep", params={"seconds": 1.0})
        from .tasks import noop_sleep

        async_result = noop_sleep.delay(str(job.id), 1.0)
        job.celery_task_id = getattr(async_result, "id", "") or ""
        job.save(update_fields=["celery_task_id"])
        return Response(JobSerializer(job).data, status=status.HTTP_202_ACCEPTED)
