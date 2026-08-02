import pytest

from apps.jobs.models import Job

pytestmark = pytest.mark.django_db


def test_demo_job_runs_to_success(api):
    r = api.post("/api/jobs/demo/")
    assert r.status_code == 202
    job_id = r.json()["id"]
    # eager execution → already terminal by the time we poll
    r2 = api.get(f"/api/jobs/{job_id}/")
    assert r2.status_code == 200
    assert r2.json()["status"] == "succeeded"
    assert r2.json()["progress"] == 100


def test_job_list_filters(api):
    api.post("/api/jobs/demo/")
    r = api.get("/api/jobs/?status=succeeded")
    assert r.status_code == 200
    assert r.json()["count"] >= 1


def test_job_cross_user_isolation(api, other_api):
    job_id = api.post("/api/jobs/demo/").json()["id"]
    assert other_api.get(f"/api/jobs/{job_id}/").status_code == 404


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
    Job.objects.filter(pk=job.pk).update(
        created_at=timezone.now() - timedelta(seconds=settings.JOB_STALL_TIMEOUT + 60),
    )

    assert reap_stalled_jobs() == 1
    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "timeout"
    assert "owner_password" not in job.params
    assert job.params["permissions"] == {"print": "none"}, "the rest of the row went too"
