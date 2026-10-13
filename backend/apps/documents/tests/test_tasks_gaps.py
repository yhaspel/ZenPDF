"""`apps.documents.tasks` — the worker's failure branches (§11, §12).

The happy paths run through the API in `test_operations.py` and friends. What
this file pins is that every way a job can go wrong *ends the job*, with the
code the client switches on and a sentence a person can read — because a job
left `running` is polled for ever, and a job failed as `engine_error:
'NoneType' object has no attribute …` is a stack trace in a toast.

Each test builds the `Job` row directly and drives the task by hand, so the
branch under test is reached without the API's own validation getting there
first.
"""
from unittest.mock import patch

import pytest
from celery.exceptions import SoftTimeLimitExceeded
from django.core.files.uploadedfile import SimpleUploadedFile

from apps.core.principals import job_owner_kwargs, principal_of_document
from apps.documents import tasks
from apps.documents.models import Document, DocumentVersion
from apps.documents.tasks import (
    revert_version,
    run_cross_document_operation,
    run_operation,
)
from apps.jobs.models import Job
from apps.jobs.tasks import TIMEOUT_MESSAGE

pytestmark = pytest.mark.django_db


def _job(user, document=None, type_="rotate_pages", params=None, base_seq=None):
    principal = principal_of_document(document) if document is not None else user
    return Job.objects.create(
        document=document, type=type_,
        params=params if params is not None else {"pages": [0], "degrees": 90},
        base_version_seq=base_seq, **job_owner_kwargs(principal),
    )


def _doc(uploaded_doc) -> Document:
    return Document.objects.get(id=uploaded_doc["id"])


def _upload_png(api) -> str:
    import fitz

    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 20, 10))
    pix.set_rect(pix.irect, (0, 0, 255))
    upload = SimpleUploadedFile("logo.png", pix.tobytes("png"), content_type="image/png")
    resp = api.post("/api/uploads/image/", {"file": upload}, format="multipart")
    assert resp.status_code == 201, resp.content
    return resp.json()["ref"]


# --------------------------------------------------------------------------- #
# run_operation
# --------------------------------------------------------------------------- #
def test_a_job_whose_document_was_deleted_fails_as_not_found(api, user, uploaded_doc):
    job = _job(user, _doc(uploaded_doc))
    Document.objects.filter(id=uploaded_doc["id"]).update(current_version=None)
    Document.objects.filter(id=uploaded_doc["id"]).delete()
    job.refresh_from_db()
    assert job.document is None

    run_operation(str(job.id))

    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "not_found"
    assert job.error_message == "The document was deleted."


def test_a_job_on_a_document_with_no_current_version_fails_as_not_found(
        api, user, uploaded_doc):
    document = _doc(uploaded_doc)
    job = _job(user, document)
    Document.objects.filter(id=document.id).update(current_version=None)

    run_operation(str(job.id))

    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "not_found"
    assert "no current version" in job.error_message


def test_an_unexpected_exception_is_logged_and_fails_the_job_as_engine_error(
        api, user, uploaded_doc, caplog):
    import logging

    job = _job(user, _doc(uploaded_doc))
    with patch.object(tasks.P, "rotate_pages", side_effect=RuntimeError("kaboom")), \
            caplog.at_level(logging.ERROR, logger="apps.documents.tasks"):
        run_operation(str(job.id))

    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "engine_error"
    assert job.error_message == "Operation failed: kaboom"
    assert f"job {job.id} failed unexpectedly" in caplog.text
    # Nothing was written: versions are immutable and the head did not move.
    assert _doc(uploaded_doc).current_version.seq == 1


def test_a_soft_time_limit_inside_the_engine_fails_the_job_as_timeout(
        api, user, uploaded_doc):
    job = _job(user, _doc(uploaded_doc))
    with patch.object(tasks.P, "rotate_pages", side_effect=SoftTimeLimitExceeded(60)):
        run_operation(str(job.id))

    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "timeout"
    assert job.error_message == TIMEOUT_MESSAGE


def test_an_unknown_single_document_op_that_passed_the_registry_fails_cleanly(
        api, user, uploaded_doc):
    """`_apply_single` is the last dispatch; an op registered but not handled
    there must fail the job, not raise out of the worker."""
    from apps.pdf_engine import registry

    document = _doc(uploaded_doc)
    job = _job(user, document, type_="mystery_op", params={})
    fake = registry.Op("mystery_op", "default", {"type": "object"}, "version")
    with patch.dict(registry.OPERATIONS, {"mystery_op": fake}):
        run_operation(str(job.id))

    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "engine_error"
    assert "Unsupported single-document op 'mystery_op'" in job.error_message


def test_extract_pages_as_a_version_keeps_only_those_pages(api, user, uploaded_doc):
    document = _doc(uploaded_doc)
    job = _job(user, document, type_="extract_pages", params={"pages": [0, 2]})
    run_operation(str(job.id))

    job.refresh_from_db()
    assert job.status == Job.Status.SUCCEEDED, job.error_message
    document.refresh_from_db()
    assert document.current_version.seq == 2
    assert document.current_version.label == "Extracted 2 page(s)"
    assert document.page_count == 2


def test_replace_image_swaps_the_image_on_the_page(api, user, uploaded_doc):
    document = _doc(uploaded_doc)
    first = _upload_png(api)
    add = _job(user, document, type_="add_image", params={
        "page": 0, "rect": {"x": 0.1, "y": 0.6, "w": 0.3, "h": 0.2}, "image_ref": first,
    })
    run_operation(str(add.id))
    add.refresh_from_db()
    assert add.status == Job.Status.SUCCEEDED, add.error_message
    images = api.get(f"/api/documents/{document.id}/images/?page=0").json()["images"]
    assert len(images) == 1

    second = _upload_png(api)
    replace = _job(user, document, type_="replace_image",
                   params={"page": 0, "xref": images[0]["xref"], "image_ref": second})
    run_operation(str(replace.id))

    replace.refresh_from_db()
    assert replace.status == Job.Status.SUCCEEDED, replace.error_message
    document.refresh_from_db()
    assert document.current_version.label == "Replaced image"
    after = api.get(f"/api/documents/{document.id}/images/?page=0").json()["images"]
    assert len(after) == 1


def test_edit_link_rewrites_the_link_target(api, user, uploaded_doc):
    document = _doc(uploaded_doc)
    rect = {"x": 0.1, "y": 0.5, "w": 0.2, "h": 0.03}
    add = _job(user, document, type_="add_link",
               params={"page": 0, "rect": rect, "kind": "uri", "uri": "https://a.example"})
    run_operation(str(add.id))
    add.refresh_from_db()
    assert add.status == Job.Status.SUCCEEDED, add.error_message

    edit = _job(user, document, type_="edit_link", params={
        "page": 0, "index": 0, "rect": rect, "kind": "uri", "uri": "https://b.example",
    })
    run_operation(str(edit.id))

    edit.refresh_from_db()
    assert edit.status == Job.Status.SUCCEEDED, edit.error_message
    document.refresh_from_db()
    assert document.current_version.label == "Edited link"
    links = api.get(f"/api/documents/{document.id}/links/?page=0").json()["links"]
    assert [link["uri"] for link in links] == ["https://b.example"]


# --------------------------------------------------------------------------- #
# run_cross_document_operation
# --------------------------------------------------------------------------- #
def test_a_url_conversion_goes_through_the_engine_and_lands_as_a_document(
        api, user, fixture_bytes):
    job = _job(user, type_="convert_from", params={"url": "https://example.com/page"})
    pdf = fixture_bytes("text.pdf")
    with patch.object(tasks.CV, "convert_from", return_value=(pdf, "example.com")) as convert:
        run_cross_document_operation(str(job.id))

    convert.assert_called_once_with(url="https://example.com/page")
    job.refresh_from_db()
    assert job.status == Job.Status.SUCCEEDED, job.error_message
    new_id = job.result["documents"][0]
    document = Document.objects.get(id=new_id)
    assert document.title == "example.com"
    assert document.owner_id == user.pk
    assert document.page_count == 3


def test_a_conversion_with_neither_file_nor_url_fails_as_validation_error(api, user):
    job = _job(user, type_="convert_from", params={"fit": "a4"})
    with patch.object(tasks.CV, "convert_from") as convert:
        run_cross_document_operation(str(job.id))
    convert.assert_not_called()
    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "validation_error"
    assert "Provide a file to convert or a web address" in job.error_message


def test_an_unknown_cross_document_op_fails_as_validation_error(api, user):
    job = _job(user, type_="teleport", params={})
    run_cross_document_operation(str(job.id))
    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "validation_error"
    assert "Unsupported cross-doc op 'teleport'" in job.error_message
    assert Document.objects.count() == 0


def test_a_cross_document_op_whose_source_vanished_fails_as_not_found(api, user, uploaded_doc):
    job = _job(user, type_="merge", params={
        "document_ids": [uploaded_doc["id"], "00000000-0000-0000-0000-000000000000"],
    })
    run_cross_document_operation(str(job.id))
    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "not_found"


def test_a_cross_document_op_on_a_document_with_no_version_fails_as_not_found(
        api, user, uploaded_doc):
    Document.objects.filter(id=uploaded_doc["id"]).update(current_version=None)
    job = _job(user, type_="merge", params={"document_ids": [uploaded_doc["id"],
                                                             uploaded_doc["id"]]})
    run_cross_document_operation(str(job.id))
    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "not_found"
    assert "no readable version" in job.error_message


def test_a_cross_document_soft_limit_fails_the_job_as_timeout(api, user, uploaded_doc):
    job = _job(user, type_="merge", params={"document_ids": [uploaded_doc["id"],
                                                             uploaded_doc["id"]]})
    with patch.object(tasks.P, "merge", side_effect=SoftTimeLimitExceeded(60)):
        run_cross_document_operation(str(job.id))
    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "timeout"
    assert job.error_message == TIMEOUT_MESSAGE


def test_a_cross_document_unexpected_exception_fails_as_engine_error(api, user, uploaded_doc):
    job = _job(user, type_="merge", params={"document_ids": [uploaded_doc["id"],
                                                             uploaded_doc["id"]]})
    with patch.object(tasks.P, "merge", side_effect=RuntimeError("kaboom")):
        run_cross_document_operation(str(job.id))
    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "engine_error"
    assert job.error_message == "Operation failed: kaboom"


def test_a_cross_document_quota_refusal_keeps_its_own_code(api, user, uploaded_doc):
    from apps.core.exceptions import QuotaExceeded

    job = _job(user, type_="merge", params={"document_ids": [uploaded_doc["id"],
                                                             uploaded_doc["id"]]})
    exc = QuotaExceeded("Over quota.")
    exc.zen_details = {"tier": "free"}
    with patch.object(tasks.L, "enforce_storage", side_effect=exc):
        run_cross_document_operation(str(job.id))
    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "quota_exceeded"
    assert job.error_message == "Over quota."
    assert job.error_details == {"tier": "free"}


# --------------------------------------------------------------------------- #
# revert_version
# --------------------------------------------------------------------------- #
def test_a_revert_whose_document_was_deleted_fails_as_not_found(api, user, uploaded_doc):
    job = _job(user, _doc(uploaded_doc), type_="revert_version", params={"seq": 1})
    Document.objects.filter(id=uploaded_doc["id"]).update(current_version=None)
    Document.objects.filter(id=uploaded_doc["id"]).delete()

    revert_version(str(job.id))

    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "not_found"
    assert job.error_message == "The document was deleted."


def test_a_revert_on_a_stale_base_version_is_a_version_conflict(api, user, uploaded_doc):
    document = _doc(uploaded_doc)
    job = _job(user, document, type_="revert_version", params={"seq": 1}, base_seq=7)
    revert_version(str(job.id))

    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "version_conflict"
    assert document.versions.count() == 1


def test_a_revert_when_the_head_went_missing_is_a_version_conflict(api, user, uploaded_doc):
    document = _doc(uploaded_doc)
    job = _job(user, document, type_="revert_version", params={"seq": 1}, base_seq=1)
    Document.objects.filter(id=document.id).update(current_version=None)
    revert_version(str(job.id))

    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "version_conflict"


def test_a_revert_to_a_version_that_does_not_exist_is_not_found(api, user, uploaded_doc):
    document = _doc(uploaded_doc)
    job = _job(user, document, type_="revert_version", params={"seq": 42})
    revert_version(str(job.id))

    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "not_found"
    assert job.error_message == "Version 42 not found."


def test_a_revert_soft_limit_fails_the_job_as_timeout(api, user, uploaded_doc):
    document = _doc(uploaded_doc)
    job = _job(user, document, type_="revert_version", params={"seq": 1})
    with patch.object(tasks, "_version_bytes", side_effect=SoftTimeLimitExceeded(60)):
        revert_version(str(job.id))

    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "timeout"
    assert job.error_message == TIMEOUT_MESSAGE


def test_a_revert_unexpected_exception_fails_as_engine_error(api, user, uploaded_doc):
    document = _doc(uploaded_doc)
    job = _job(user, document, type_="revert_version", params={"seq": 1})
    with patch.object(tasks, "_save_new_version", side_effect=RuntimeError("disk full")):
        revert_version(str(job.id))

    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "engine_error"
    assert job.error_message == "Revert failed: disk full"
    assert document.versions.count() == 1


def test_a_revert_quota_refusal_keeps_its_own_code(api, user, uploaded_doc):
    from apps.core.exceptions import QuotaExceeded

    document = _doc(uploaded_doc)
    job = _job(user, document, type_="revert_version", params={"seq": 1})
    exc = QuotaExceeded("Over quota.")
    exc.zen_details = {"tier": "free"}
    with patch.object(tasks.L, "enforce_storage", side_effect=exc):
        revert_version(str(job.id))

    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "quota_exceeded"
    assert job.error_details == {"tier": "free"}


def test_a_revert_redelivered_while_running_is_failed_as_timeout(api, user, uploaded_doc):
    document = _doc(uploaded_doc)
    job = _job(user, document, type_="revert_version", params={"seq": 1})
    Job.objects.filter(id=job.id).update(status=Job.Status.RUNNING)

    revert_version(str(job.id))

    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "timeout"
    assert DocumentVersion.objects.filter(document=document).count() == 1


# --------------------------------------------------------------------------- #
# generate_thumbnails_task
# --------------------------------------------------------------------------- #
def test_thumbnails_for_a_vanished_document_are_a_no_op(api, uploaded_doc):
    from apps.pdf_engine.storage import get_storage

    with patch.object(tasks.R, "render_thumbnail") as render:
        tasks.generate_thumbnails_task("00000000-0000-0000-0000-000000000000", 1, 3)
        tasks.generate_thumbnails_task(uploaded_doc["id"], 99, 3)
    render.assert_not_called()
    assert not get_storage().exists(f"thumbs/{uploaded_doc['id']}/99/p0@240.png")


def test_thumbnails_stop_at_the_soft_limit_but_keep_what_was_rendered(api, uploaded_doc):
    from apps.pdf_engine.storage import get_storage

    seq = uploaded_doc["current_version"]["seq"]
    storage = get_storage()
    for page in range(3):
        storage.delete(f"thumbs/{uploaded_doc['id']}/{seq}/p{page}@77.png")
    real = tasks.R.render_thumbnail
    calls = []

    def limited(data, page, width, *args, **kwargs):
        calls.append(page)
        if page == 1:
            raise SoftTimeLimitExceeded(60)
        return real(data, page, width, *args, **kwargs)

    with patch.object(tasks.R, "render_thumbnail", side_effect=limited):
        tasks.generate_thumbnails_task(uploaded_doc["id"], seq, 3, width=77)

    assert calls == [0, 1]
    assert storage.exists(f"thumbs/{uploaded_doc['id']}/{seq}/p0@77.png")
    assert not storage.exists(f"thumbs/{uploaded_doc['id']}/{seq}/p2@77.png")


def test_a_page_that_fails_to_render_does_not_stop_the_rest(api, uploaded_doc):
    from apps.pdf_engine.storage import get_storage

    seq = uploaded_doc["current_version"]["seq"]
    storage = get_storage()
    real = tasks.R.render_thumbnail

    def flaky(data, page, width, *args, **kwargs):
        if page == 1:
            raise RuntimeError("bad page")
        return real(data, page, width, *args, **kwargs)

    with patch.object(tasks.R, "render_thumbnail", side_effect=flaky):
        tasks.generate_thumbnails_task(uploaded_doc["id"], seq, 3, width=78)

    assert storage.exists(f"thumbs/{uploaded_doc['id']}/{seq}/p0@78.png")
    assert not storage.exists(f"thumbs/{uploaded_doc['id']}/{seq}/p1@78.png")
    assert storage.exists(f"thumbs/{uploaded_doc['id']}/{seq}/p2@78.png")


# --------------------------------------------------------------------------- #
# Cooperative cancel: a job cancelled while the engine was working writes nothing
# --------------------------------------------------------------------------- #
def _cancel_during(job):
    """Flip the row to CANCELED from 'another request' while the task runs."""
    def cancel(*_args, **_kwargs):
        Job.objects.filter(pk=job.pk).update(status=Job.Status.CANCELED)
    return cancel


def test_a_cross_document_job_cancelled_mid_flight_creates_no_document(
        api, user, uploaded_doc):
    job = _job(user, type_="merge", params={"document_ids": [uploaded_doc["id"],
                                                             uploaded_doc["id"]]})
    before = Document.objects.count()
    real = tasks.P.merge

    def merge_then_cancel(*args, **kwargs):
        _cancel_during(job)()
        return real(*args, **kwargs)

    with patch.object(tasks.P, "merge", side_effect=merge_then_cancel):
        run_cross_document_operation(str(job.id))

    job.refresh_from_db()
    assert job.status == Job.Status.CANCELED
    assert job.result is None
    assert Document.objects.count() == before


def test_a_revert_cancelled_mid_flight_mints_no_version(api, user, uploaded_doc):
    document = _doc(uploaded_doc)
    job = _job(user, document, type_="revert_version", params={"seq": 1})
    real = tasks._version_bytes

    def read_then_cancel(version):
        _cancel_during(job)()
        return real(version)

    with patch.object(tasks, "_version_bytes", side_effect=read_then_cancel):
        revert_version(str(job.id))

    job.refresh_from_db()
    assert job.status == Job.Status.CANCELED
    assert document.versions.count() == 1


def test_an_upload_ref_conversion_discards_the_parked_source_even_on_failure(api, user):
    """The parked file is charged to the principal; the `finally` must refund it
    whether or not the engine managed to convert it."""
    import fitz

    from apps.core.assets import principal_prefix
    from apps.pdf_engine.storage import get_storage

    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 12, 12))
    pix.set_rect(pix.irect, (1, 2, 3))
    upload = SimpleUploadedFile("scan.png", pix.tobytes("png"), content_type="image/png")
    resp = api.post("/api/uploads/source/", {"file": upload}, format="multipart")
    assert resp.status_code == 201, resp.content
    ref = resp.json()["ref"]
    assert get_storage().list_prefix(principal_prefix(user))

    job = _job(user, type_="convert_from", params={"upload_ref": ref})
    with patch.object(tasks.CV, "convert_from", side_effect=RuntimeError("no converter")):
        run_cross_document_operation(str(job.id))

    job.refresh_from_db()
    assert job.status == Job.Status.FAILED
    assert job.error_code == "engine_error"
    assert get_storage().list_prefix(principal_prefix(user)) == []
    user.refresh_from_db()
    assert user.storage_bytes_used == 0
