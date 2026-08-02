"""What happens when a job is killed rather than failing (§10.1, §12).

The hostile corpus proves the guards fire. This is the other half of that
acceptance criterion: what the *worker* does when a guard does not fire and the
job has to be stopped from outside.

Two kill paths, and only one of them can leave a message:

* **the soft limit** raises `SoftTimeLimitExceeded` inside the task, so the
  task itself marks the job failed — testable here, eagerly;
* **the hard limit and the OOM killer** are a SIGKILL. No handler runs, the row
  stays `running`, and only `reap_stalled_jobs` closes it. That half is
  asserted here at the sweep, and exercised for real by
  `docs/ops/queue-stuck.md`'s drill rather than by CI.
"""
import pytest
from celery.exceptions import SoftTimeLimitExceeded

from apps.jobs.models import Job
from apps.jobs.tasks import TIMEOUT_MESSAGE

pytestmark = pytest.mark.django_db


def test_a_soft_limit_fails_the_job_with_a_sentence_a_person_can_read(
        api, uploaded_doc, monkeypatch):
    """`error_message` is rendered verbatim in a toast, so it must not be
    `SoftTimeLimitExceeded(60,)`."""
    from apps.documents import tasks

    def timeout(*_args, **_kwargs):
        raise SoftTimeLimitExceeded(60)

    # `doc_lock` rather than `registry.get_op`: the view validates the op type
    # before dispatch, so patching the registry raises in the request thread
    # and never reaches the task at all.
    monkeypatch.setattr(tasks, "doc_lock", timeout)
    resp = api.post(
        f"/api/documents/{uploaded_doc['id']}/operations/",
        {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90}},
        format="json",
    )
    job = Job.objects.get(id=resp.json()["id"])
    assert job.status == Job.Status.FAILED
    assert job.error_code == "timeout"
    assert job.error_message == TIMEOUT_MESSAGE
    assert "SoftTimeLimit" not in job.error_message


def test_a_document_that_killed_a_worker_is_not_fed_to_the_next_one(
        api, uploaded_doc):
    """A SIGKILL runs no handler, so the row is still `running` when the broker
    redelivers. Running it again means handing a worker the same file that just
    killed one, for as long as it keeps killing them."""
    from apps.documents.tasks import run_operation

    resp = api.post(
        f"/api/documents/{uploaded_doc['id']}/operations/",
        {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90}},
        format="json",
    )
    job = Job.objects.get(id=resp.json()["id"])
    # Put it back the way a killed worker leaves it.
    Job.objects.filter(id=job.id).update(status=Job.Status.RUNNING,
                                         finished_at=None)

    run_operation(str(job.id))

    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "timeout"
    assert job.error_message == TIMEOUT_MESSAGE


def test_the_sweep_and_the_task_say_the_same_thing(api, uploaded_doc, settings):
    """Two kill paths, one sentence — a user cannot tell which one hit them,
    and should not have to."""
    from django.utils import timezone

    from apps.jobs.tasks import reap_stalled_jobs

    resp = api.post(
        f"/api/documents/{uploaded_doc['id']}/operations/",
        {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90}},
        format="json",
    )
    job = Job.objects.get(id=resp.json()["id"])
    # The sweep ages on `created_at` — a job killed before it ever started
    # running has the same problem and no `started_at` to measure.
    stale = timezone.now() - timezone.timedelta(
        seconds=settings.JOB_STALL_TIMEOUT + 60)
    Job.objects.filter(id=job.id).update(status=Job.Status.RUNNING,
                                         created_at=stale, finished_at=None)

    assert reap_stalled_jobs() == 1
    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_message == TIMEOUT_MESSAGE
