"""`apps.jobs.views` — cancel semantics and the expired-download answer (§11, §15).

`test_jobs.py` pins that a queued job can be cancelled. What it leaves open is
*what cancelling does* beyond flipping the row: a queued job's Celery task is
revoked so a worker never picks it up; a broker that refuses the revoke must
not turn the cancel into a 500 (the row is still cancelled and the worker's
own status check catches it); a running job is cancelled cooperatively; a
finished job is left exactly as it was. And an export whose blob the 24 h TTL
has already swept answers 404 with the sentence the UI promised, not a 500
from storage.
"""
from unittest.mock import patch

import pytest

from apps.jobs.models import Job
from apps.pdf_engine.storage import get_storage

pytestmark = pytest.mark.django_db


def _job(user, status, **fields):
    return Job.objects.create(user=user, type="noop_sleep", status=status, **fields)


def test_cancelling_a_queued_job_revokes_its_celery_task(api, user):
    job = _job(user, Job.Status.QUEUED, celery_task_id="task-123")
    with patch("config.celery.app.control.revoke") as revoke:
        resp = api.post(f"/api/jobs/{job.id}/cancel/")
    assert resp.status_code == 200, resp.content
    revoke.assert_called_once_with("task-123")
    job.refresh_from_db()
    assert job.status == Job.Status.CANCELED
    assert job.finished_at is not None


def test_a_queued_job_without_a_task_id_is_cancelled_without_a_revoke(api, user):
    job = _job(user, Job.Status.QUEUED, celery_task_id="")
    with patch("config.celery.app.control.revoke") as revoke:
        resp = api.post(f"/api/jobs/{job.id}/cancel/")
    assert resp.status_code == 200
    revoke.assert_not_called()
    job.refresh_from_db()
    assert job.status == Job.Status.CANCELED


def test_a_broker_that_refuses_the_revoke_does_not_stop_the_cancel(api, user):
    job = _job(user, Job.Status.QUEUED, celery_task_id="task-123")
    with patch("config.celery.app.control.revoke", side_effect=OSError("broker down")):
        resp = api.post(f"/api/jobs/{job.id}/cancel/")
    assert resp.status_code == 200, resp.content
    assert resp.json()["status"] == "canceled"
    job.refresh_from_db()
    assert job.status == Job.Status.CANCELED


def test_cancelling_a_running_job_marks_it_canceled_cooperatively(api, user):
    """No revoke for a job already on a worker: the task checks its own
    status between steps and stops itself."""
    job = _job(user, Job.Status.RUNNING, celery_task_id="task-123")
    with patch("config.celery.app.control.revoke") as revoke:
        resp = api.post(f"/api/jobs/{job.id}/cancel/")
    assert resp.status_code == 200
    revoke.assert_not_called()
    job.refresh_from_db()
    assert job.status == Job.Status.CANCELED
    assert job.finished_at is not None


def test_cancelling_a_running_job_drops_its_password_material(api, user):
    job = _job(user, Job.Status.RUNNING, params={"password": "hunter2", "keep": 1})
    api.post(f"/api/jobs/{job.id}/cancel/")
    job.refresh_from_db()
    assert job.params == {"keep": 1}


@pytest.mark.parametrize("status", [Job.Status.SUCCEEDED, Job.Status.FAILED,
                                    Job.Status.CANCELED])
def test_cancelling_a_finished_job_leaves_it_as_it_was(api, user, status):
    job = _job(user, status, celery_task_id="task-123")
    with patch("config.celery.app.control.revoke") as revoke:
        resp = api.post(f"/api/jobs/{job.id}/cancel/")
    assert resp.status_code == 200
    assert resp.json()["status"] == status
    revoke.assert_not_called()
    job.refresh_from_db()
    assert job.status == status


def test_another_principal_cannot_cancel_a_job(api, other_api, user):
    job = _job(user, Job.Status.QUEUED)
    assert other_api.post(f"/api/jobs/{job.id}/cancel/").status_code == 404
    job.refresh_from_db()
    assert job.status == Job.Status.QUEUED


def test_an_export_whose_blob_was_swept_says_it_expired(api, user):
    key = f"exports/{user.pk}/gone.txt"
    job = _job(user, Job.Status.SUCCEEDED, result={"export": {
        "storage_key": key, "content_type": "text/plain", "filename": "gone.txt",
    }})
    assert not get_storage().exists(key)
    resp = api.get(f"/api/jobs/{job.id}/download/")
    assert resp.status_code == 404
    assert "expired" in resp.json()["error"]["message"].lower()


def test_an_export_still_in_storage_downloads_with_its_filename(api, user):
    key = f"exports/{user.pk}/here.txt"
    get_storage().put_bytes(key, b"hello", content_type="text/plain")
    try:
        job = _job(user, Job.Status.SUCCEEDED, result={"export": {
            "storage_key": key, "content_type": "text/plain",
            "filename": 'we"ird.txt',
        }})
        resp = api.get(f"/api/jobs/{job.id}/download/")
        assert resp.status_code == 200
        assert resp.content == b"hello"
        assert resp["Content-Type"] == "text/plain"
        assert resp["Content-Disposition"] == 'attachment; filename="weird.txt"'
    finally:
        get_storage().delete(key)
