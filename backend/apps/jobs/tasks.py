"""Celery tasks owned by the jobs app.

`noop_sleep` is the phase-0 pipeline smoke task (enqueue → poll → succeeded).
It is retained as a lightweight liveness probe for the async stack.
`reap_stalled_jobs` is the beat sweep that closes out jobs whose worker died.
"""
import time
from datetime import timedelta

from celery import shared_task
from django.conf import settings
from django.db.models import Q
from django.utils import timezone

from .models import Job

#: What both kill paths say. A soft limit is reported by the task itself; a
#: hard limit or an OOM kill is reported by the sweep below, because no handler
#: ran. `error_message` is rendered verbatim in a toast, so neither may be
#: `SoftTimeLimitExceeded(60,)`.
TIMEOUT_MESSAGE = "The job stopped responding and was canceled."


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

    **Age is measured from `started_at`, not `created_at`.** Aging a RUNNING job
    from when it was *created* fails healthy work for the sin of having waited:
    a busy heavy lane with two workers and a queue of long OCR jobs hands the
    thirty-first arrival a "stopped responding" it never earned, while it is
    still running perfectly. A job that has not started yet is a different
    question — nothing is executing, so nothing has stalled — and it gets a
    deliberately generous cutoff of its own, because queue depth is a capacity
    symptom rather than a fault.
    """
    now = timezone.now()
    running_cutoff = now - timedelta(seconds=settings.JOB_STALL_TIMEOUT)
    queued_cutoff = now - timedelta(seconds=settings.JOB_QUEUE_STALL_TIMEOUT)
    stalled = list(Job.objects.filter(
        # Running long past its limit: its worker is gone.
        Q(status=Job.Status.RUNNING, started_at__lt=running_cutoff)
        # Never started, and old enough that the broker has plainly lost it.
        # `started_at` is null for every QUEUED row, and for the odd RUNNING one
        # written by an older release, so both are covered here.
        | Q(status__in=[Job.Status.QUEUED, Job.Status.RUNNING],
            started_at__isnull=True, created_at__lt=queued_cutoff)
    ))
    for job in stalled:
        # One row at a time, through `mark_failed`, rather than a queryset
        # `.update()`: a killed worker never ran the terminal transition, so
        # this is the *only* place password material on that row is ever
        # dropped (`Job.SENSITIVE_PARAMS`, phase-07). An `.update()` left it in
        # the database in plaintext, and nothing else would have removed it.
        job.mark_failed("timeout", TIMEOUT_MESSAGE)
    return len(stalled)
