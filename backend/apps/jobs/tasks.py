"""Celery tasks owned by the jobs app.

`noop_sleep` is the phase-0 pipeline smoke task (enqueue → poll → succeeded).
It is retained as a lightweight liveness probe for the async stack.
`reap_stalled_jobs` is the beat sweep that closes out jobs whose worker died.
"""
import time
from datetime import timedelta

from celery import shared_task
from django.conf import settings
from django.utils import timezone

from .models import Job


@shared_task(name="apps.jobs.tasks.noop_sleep", bind=True)
def noop_sleep(self, job_id: str, seconds: float = 1.0):
    """Sleep, reporting progress, then succeed — proves the worker pipeline."""
    try:
        job = Job.objects.get(id=job_id)
    except Job.DoesNotExist:
        return

    if job.status == Job.Status.CANCELED:
        return

    job.celery_task_id = self.request.id or ""
    job.save(update_fields=["celery_task_id"])
    job.mark_running()

    steps = 5
    for i in range(steps):
        time.sleep(seconds / steps)
        job.refresh_from_db(fields=["status"])
        if job.status == Job.Status.CANCELED:
            return
        job.set_progress(int((i + 1) / steps * 100))

    job.mark_succeeded({"message": "noop complete"})


@shared_task(name="apps.jobs.tasks.reap_stalled_jobs")
def reap_stalled_jobs() -> int:
    """Fail jobs whose worker died before writing a terminal state (§11).

    A hard time limit or an OOM kill terminates the process outright, so the row
    stays queued/running forever and permanently consumes one of the owner's
    MAX_CONCURRENT_JOBS slots.
    """
    now = timezone.now()
    cutoff = now - timedelta(seconds=settings.JOB_STALL_TIMEOUT)
    stalled = list(Job.objects.filter(
        status__in=[Job.Status.QUEUED, Job.Status.RUNNING], created_at__lt=cutoff
    ))
    for job in stalled:
        # One row at a time, through `mark_failed`, rather than a queryset
        # `.update()`: a killed worker never ran the terminal transition, so
        # this is the *only* place password material on that row is ever
        # dropped (`Job.SENSITIVE_PARAMS`, phase-07). An `.update()` left it in
        # the database in plaintext, and nothing else would have removed it.
        job.mark_failed("timeout", "The job stopped responding and was canceled.")
    return len(stalled)
