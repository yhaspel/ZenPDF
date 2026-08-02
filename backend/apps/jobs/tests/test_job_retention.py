"""Job retention (§15).

Two windows, and the difference between them is the point: the *inputs* to an
operation are a record of what was in somebody's document and go at a month;
the row is our own record of what ran and goes at a year, which is past the
point where anybody could notice it leaving the twenty-row panel in Settings.
"""
import pytest
from django.utils import timezone

from apps.jobs.models import Job

pytestmark = pytest.mark.django_db


def _age(job, days):
    Job.objects.filter(id=job.id).update(
        finished_at=timezone.now() - timezone.timedelta(days=days))


def _run(api, doc_id):
    resp = api.post(
        f"/api/documents/{doc_id}/operations/",
        {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90}},
        format="json",
    )
    return Job.objects.get(id=resp.json()["id"])


def test_the_inputs_go_at_a_month_and_the_row_stays(api, uploaded_doc):
    """Settings → Recent jobs is unchanged: same row, same type, same status."""
    from apps.core.tasks import job_params_purge

    job = _run(api, uploaded_doc["id"])
    assert job.params, "the fixture must start with inputs to clear"
    _age(job, 31)

    assert job_params_purge() == 1
    job.refresh_from_db()
    assert job.params == {}
    assert job.status == Job.Status.SUCCEEDED
    assert job.type == "rotate_pages"
    # …and the panel still has something to show.
    assert api.get("/api/jobs/").json()["count"] >= 1


def test_a_recent_job_keeps_its_inputs(api, uploaded_doc):
    from apps.core.tasks import job_params_purge

    job = _run(api, uploaded_doc["id"])
    _age(job, 3)
    assert job_params_purge() == 0
    job.refresh_from_db()
    assert job.params


def test_the_row_goes_at_a_year(api, uploaded_doc):
    from apps.core.tasks import jobs_purge

    job = _run(api, uploaded_doc["id"])
    _age(job, 366)
    assert jobs_purge()["jobs"] == 1
    assert not Job.objects.filter(id=job.id).exists()


def test_a_job_still_in_flight_is_never_swept(api, uploaded_doc):
    """`reap_stalled_jobs` makes every row terminal within half an hour, so a
    `running` row at a year means the reaper is broken — and it should stay
    visible saying so rather than being quietly deleted."""
    from apps.core.tasks import job_params_purge, jobs_purge

    job = _run(api, uploaded_doc["id"])
    Job.objects.filter(id=job.id).update(
        status=Job.Status.RUNNING,
        finished_at=timezone.now() - timezone.timedelta(days=400))

    assert jobs_purge()["jobs"] == 0
    assert job_params_purge() == 0
    assert Job.objects.filter(id=job.id).exists()


def test_the_export_blob_goes_before_the_row_that_names_it(api, uploaded_doc):
    """`exports_purge` finds artefacts by iterating Job rows. Delete the row
    first and nothing can ever find the blob again."""
    from apps.core.tasks import jobs_purge
    from apps.pdf_engine.storage import get_storage

    job = _run(api, uploaded_doc["id"])
    storage = get_storage()
    key = f"exports/{job.id}/pages.zip"
    storage.put_bytes(key, b"PK\x05\x06" + b"\x00" * 18)
    Job.objects.filter(id=job.id).update(
        result={"export": {"storage_key": key, "size_bytes": 22}})
    _age(job, 400)

    stats = jobs_purge()
    assert stats["jobs"] == 1
    assert stats["blobs"] >= 1
    with pytest.raises(Exception, match=r".*"):  # noqa: B017 - backend-specific
        storage.get_bytes(key)
