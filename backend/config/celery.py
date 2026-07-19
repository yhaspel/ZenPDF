"""Celery application for ZenPDF.

Queues and time limits follow 01-architecture.md §12. Beat entries (§15) are
registered by their owning phase; none are active in phases 0–2 except the
generic scheduled GC hooks, which are added when their features land.
"""
import os

from celery import Celery

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.dev")

app = Celery("zenpdf")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()


@app.task(bind=True, ignore_result=True)
def debug_task(self):
    print(f"Request: {self.request!r}")
