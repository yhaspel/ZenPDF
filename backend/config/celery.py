"""Celery application for ZenPDF.

Queues and time limits follow 01-architecture.md §12. Beat entries (§15) are
registered by their owning phase; none are active in phases 0–2 except the
generic scheduled GC hooks, which are added when their features land.
"""
import os

from celery import Celery
from celery.signals import task_postrun, task_prerun

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.dev")

app = Celery("zenpdf")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()


#: Tasks whose first positional argument is a `Job` id.
JOB_ID_FIRST_ARG = {
    "apps.documents.tasks.run_operation",
    "apps.documents.tasks.run_cross_document_operation",
    "apps.documents.tasks.revert_version",
}


@task_prerun.connect
def _bind_correlation(task_id=None, task=None, args=None, kwargs=None, **_):
    """Carry the ids into the worker (§10.4).

    A request id that stops at the API boundary answers half of "what happened
    to this upload" — the interesting half runs in another container. The
    caller passes it in `headers`, and the job id is the first argument of
    every operation task by convention, so one grep spans both processes.
    """
    from apps.core import logging as zen_logging

    headers = getattr(getattr(task, "request", None), "headers", None) or {}
    # Only the operation tasks take a job id as their first argument. Binding
    # it blindly labelled a thumbnail render with a *document* id, which is a
    # worse kind of wrong than an empty field: it looks like an answer.
    name = getattr(task, "name", "")
    job_id = str(args[0]) if args and name in JOB_ID_FIRST_ARG else ""
    zen_logging.bind(
        request_id=str(headers.get("zen_request_id") or "")
        or zen_logging.new_request_id(),
        principal=str(headers.get("zen_principal") or ""),
        job_id=job_id,
    )


@task_postrun.connect
def _clear_correlation(**_):
    from apps.core import logging as zen_logging

    zen_logging.request_id_var.set("")
    zen_logging.principal_var.set("")
    zen_logging.job_id_var.set("")
