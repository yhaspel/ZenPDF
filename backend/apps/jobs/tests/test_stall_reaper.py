"""M3 — what the stalled-job sweep is allowed to conclude (§11, §12).

Two separate mistakes, both of which end with a user being told something
untrue about their own job.

1. The sweep aged QUEUED and RUNNING rows alike on `created_at`, so a job that
   had merely *waited* — two heavy workers, a queue of long OCR runs — was
   marked "stopped responding" while it was running perfectly. Queue depth is
   not a fault, and a false FAILED is worse than a slow SUCCEEDED because the
   work is thrown away.
2. The worker's completion path re-checked only CANCELED, so a job the sweep
   had already failed could finish and write SUCCEEDED over the top: the user
   was told it failed and then handed a result, and the concurrency accounting
   counted one job finishing twice.
"""
from datetime import timedelta

import pytest
from django.conf import settings
from django.utils import timezone

from apps.jobs.models import Job
from apps.jobs.tasks import reap_stalled_jobs

pytestmark = pytest.mark.django_db


def _age(job, *, created=None, started=None):
    """Backdate a row without going through the model's transitions."""
    fields = {}
    now = timezone.now()
    if created is not None:
        fields["created_at"] = now - timedelta(seconds=created)
    if started is not None:
        fields["started_at"] = now - timedelta(seconds=started)
    Job.objects.filter(pk=job.pk).update(**fields)
    job.refresh_from_db()
    return job


# --------------------------------------------------------------------------- #
# What the sweep measures
# --------------------------------------------------------------------------- #
def test_a_job_that_only_waited_a_long_time_is_not_reaped(user):
    """Created hours ago, started a minute ago: it is working, not stalled."""
    job = Job.objects.create(user=user, type="ocr", status=Job.Status.RUNNING)
    _age(job, created=settings.JOB_STALL_TIMEOUT * 3, started=30)

    assert reap_stalled_jobs() == 0
    job.refresh_from_db()
    assert job.status == Job.Status.RUNNING


def test_a_job_running_past_the_limit_is_reaped(user):
    job = Job.objects.create(user=user, type="ocr", status=Job.Status.RUNNING)
    _age(job, created=settings.JOB_STALL_TIMEOUT + 600,
         started=settings.JOB_STALL_TIMEOUT + 60)

    assert reap_stalled_jobs() == 1
    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "timeout"


def test_a_queued_job_gets_the_generous_cutoff_not_the_running_one(user):
    """Nothing is executing, so nothing has stalled — only the slot is held."""
    job = Job.objects.create(user=user, type="ocr", status=Job.Status.QUEUED)
    _age(job, created=settings.JOB_STALL_TIMEOUT + 60)
    assert job.started_at is None

    assert reap_stalled_jobs() == 0
    job.refresh_from_db()
    assert job.status == Job.Status.QUEUED

    # …but a job the broker has plainly lost is still swept, or its owner's
    # concurrency slot is held for ever.
    _age(job, created=settings.JOB_QUEUE_STALL_TIMEOUT + 60)
    assert reap_stalled_jobs() == 1
    job.refresh_from_db()
    assert job.status == Job.Status.FAILED


def test_a_running_row_with_no_start_time_still_gets_swept_eventually(user):
    """Belt and braces for rows written by an older release: RUNNING with a
    null `started_at` falls back to the queued cutoff rather than never."""
    job = Job.objects.create(user=user, type="ocr", status=Job.Status.RUNNING)
    _age(job, created=settings.JOB_QUEUE_STALL_TIMEOUT + 60)
    assert job.started_at is None

    assert reap_stalled_jobs() == 1
    job.refresh_from_db()
    assert job.status == Job.Status.FAILED


def test_terminal_rows_are_never_touched(user):
    for status in (Job.Status.SUCCEEDED, Job.Status.FAILED, Job.Status.CANCELED):
        job = Job.objects.create(user=user, type="ocr", status=status)
        _age(job, created=settings.JOB_QUEUE_STALL_TIMEOUT * 5,
             started=settings.JOB_QUEUE_STALL_TIMEOUT * 5)
    assert reap_stalled_jobs() == 0


# --------------------------------------------------------------------------- #
# …and what the worker is allowed to do afterwards
# --------------------------------------------------------------------------- #
def test_a_reaped_job_is_not_resurrected_as_succeeded(user, uploaded_doc,
                                                      monkeypatch):
    """The worker finishes after the sweep already gave up on it. It has to
    abandon the row rather than overwrite the ending the user was shown."""
    from apps.documents import tasks as doc_tasks
    from apps.documents.models import Document
    from apps.jobs.tasks import TIMEOUT_MESSAGE

    document = Document.objects.get(id=uploaded_doc["id"])
    job = Job.objects.create(user=user, document=document, type="rotate_pages",
                             params={"pages": [0], "degrees": 90})

    real_version_bytes = doc_tasks._version_bytes

    def reap_then_read(version):
        """Stand in for the sweep firing mid-op: `mark_running()` has already
        happened and the row is failed underneath the worker."""
        Job.objects.filter(pk=job.pk).update(
            status=Job.Status.FAILED, error_code="timeout",
            error_message=TIMEOUT_MESSAGE, finished_at=timezone.now())
        return real_version_bytes(version)

    monkeypatch.setattr(doc_tasks, "_version_bytes", reap_then_read)
    doc_tasks.run_operation.apply(args=[str(job.id)])

    job.refresh_from_db()
    assert job.status == Job.Status.FAILED, "a reaped job came back as succeeded"
    assert job.error_code == "timeout"
    assert job.error_message == TIMEOUT_MESSAGE
    # And no version was advanced under a job nobody is waiting on any more.
    assert Document.objects.get(id=document.id).versions.count() == 1


def test_an_ordinary_job_still_succeeds(api, uploaded_doc):
    """The guard is only useful if it is not simply a wall."""
    resp = api.post(f"/api/documents/{uploaded_doc['id']}/operations/",
                    {"type": "rotate_pages",
                     "params": {"pages": [0], "degrees": 90}}, format="json")
    job = Job.objects.get(id=resp.json()["id"])
    assert job.status == Job.Status.SUCCEEDED, job.error_message
