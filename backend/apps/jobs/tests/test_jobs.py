import pytest

from apps.jobs.models import Job

pytestmark = pytest.mark.django_db


def _noop_job(user):
    """Enqueue the phase-0 smoke task for `user` and return the row.

    This is what `POST /api/jobs/demo/` used to do. The endpoint is gone (L1:
    it was DEBUG-gated, so the dashboard button that called it 404ed for every
    real user), but the pipeline smoke it gave us is worth keeping, so it lives
    here instead of behind a route nobody could reach.
    """
    from apps.jobs.tasks import noop_sleep

    job = Job.objects.create(user=user, type="noop_sleep", params={"seconds": 0.05})
    noop_sleep.delay(str(job.id), 0.05)
    return job


def test_the_noop_pipeline_runs_to_success(api, user):
    job = _noop_job(user)
    # eager execution → already terminal by the time we poll
    r = api.get(f"/api/jobs/{job.id}/")
    assert r.status_code == 200
    assert r.json()["status"] == "succeeded"
    assert r.json()["progress"] == 100


def test_job_list_filters(api, user):
    _noop_job(user)
    r = api.get("/api/jobs/?status=succeeded")
    assert r.status_code == 200
    assert r.json()["count"] >= 1


def test_job_cross_user_isolation(api, other_api, user):
    job = _noop_job(user)
    assert other_api.get(f"/api/jobs/{job.id}/").status_code == 404


def test_there_is_no_demo_endpoint(api):
    """It shipped a button to every user and answered 404 in production."""
    assert api.post("/api/jobs/demo/").status_code == 404


def test_cancel_queued_job(api, user):
    job = Job.objects.create(user=user, type="noop_sleep", status=Job.Status.QUEUED)
    r = api.post(f"/api/jobs/{job.id}/cancel/")
    assert r.status_code == 200
    assert r.json()["status"] == "canceled"


def test_the_stall_reaper_drops_password_material(user):
    """The one terminal transition a killed worker never runs.

    A queryset `.update()` flips the status without touching the row's params,
    so an `encrypt` job whose worker was OOM-killed left the password sitting
    in the database in plaintext — and nothing else would ever have removed it
    (`Job.SENSITIVE_PARAMS`, phase-07).
    """
    from datetime import timedelta

    from django.conf import settings
    from django.utils import timezone

    from apps.jobs.tasks import reap_stalled_jobs

    job = Job.objects.create(
        user=user, type="encrypt", status=Job.Status.RUNNING,
        params={"owner_password": "hunter2", "permissions": {"print": "none"}},
    )
    stale = timezone.now() - timedelta(seconds=settings.JOB_STALL_TIMEOUT + 60)
    # `started_at`, not `created_at`: the sweep ages RUNNING work from when it
    # started, so that a job which merely waited behind a backlog is not failed
    # for it (M3).
    Job.objects.filter(pk=job.pk).update(created_at=stale, started_at=stale)

    assert reap_stalled_jobs() == 1
    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "timeout"
    assert "owner_password" not in job.params
    assert job.params["permissions"] == {"print": "none"}, "the rest of the row went too"
