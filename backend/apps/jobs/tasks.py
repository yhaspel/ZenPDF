"""Celery tasks owned by the jobs app.

`noop_sleep` is the phase-0 pipeline smoke task (enqueue → poll → succeeded).
It is retained as a lightweight liveness probe for the async stack.
"""
import time

from celery import shared_task

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
