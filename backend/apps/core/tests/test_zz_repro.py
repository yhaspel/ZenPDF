"""TEMPORARY review reproductions — delete after the review."""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.django_db


# --- 1. /api/health/ when the cache backend (redis db1) is unreachable ------ #
def test_health_500s_when_the_cache_is_down(anon, monkeypatch):
    from django.core.cache import cache

    def boom(*_a, **_k):
        raise ConnectionError("redis is gone")

    monkeypatch.setattr(cache, "get", boom)
    resp = anon.get("/api/health/")
    print("HEALTH STATUS WITH DEAD CACHE:", resp.status_code)
    assert resp.status_code in (200, 503), resp.status_code


# --- 2. account deletion leaves uploaded assets + exports in storage -------- #
def test_delete_account_leaves_uploaded_assets_behind(api, user, fixture_bytes):
    from apps.pdf_engine.storage import get_storage

    storage = get_storage()
    key = f"uploads/u/{user.id}/stamp.png"
    storage.put_bytes(key, b"not-really-a-png", "image/png")
    assert storage.get_bytes(key)

    resp = api.delete("/api/users/me/delete/", {"password": "pass12345"},
                      format="json")
    assert resp.status_code == 200, resp.content
    leftover = True
    try:
        storage.get_bytes(key)
    except Exception:
        leftover = False
    print("ASSET STILL IN STORAGE AFTER ACCOUNT DELETION:", leftover)
    assert leftover is False, "uploads/u/<id>/ blob survived account deletion"


def test_delete_account_leaves_export_artifacts_behind(api, user, uploaded_doc):
    from apps.jobs.models import Job
    from apps.pdf_engine.storage import get_storage

    storage = get_storage()
    job = Job.objects.create(user=user, type="split", params={})
    key = f"exports/{job.id}/out.zip"
    storage.put_bytes(key, b"zip", "application/zip")

    api.delete("/api/users/me/delete/", {"password": "pass12345"}, format="json")
    leftover = True
    try:
        storage.get_bytes(key)
    except Exception:
        leftover = False
    print("EXPORT STILL IN STORAGE AFTER ACCOUNT DELETION:", leftover)
    assert leftover is False, "exports/<job>/ blob survived account deletion"


# --- 3. a draft envelope survives deletion with recipient addresses -------- #
def test_a_never_sent_draft_survives_with_recipient_addresses(api, user,
                                                              uploaded_doc):
    from apps.esign.models import SignRequest

    user.email_verified = True
    user.save(update_fields=["email_verified"])
    request = api.post("/api/sign-requests/", {"document": uploaded_doc["id"]},
                       format="json").json()
    api.patch(f"/api/sign-requests/{request['id']}/",
              {"recipients": [{"email": "counterparty@example.com",
                               "role": "signer", "order": 1}]},
              format="json")

    resp = api.delete("/api/users/me/delete/", {"password": "pass12345"},
                      format="json")
    print("DELETE RESPONSE:", resp.json())
    row = SignRequest.objects.filter(id=request["id"]).first()
    print("DRAFT SURVIVED:", row is not None,
          "status:", getattr(row, "status", None),
          "sender_address:", repr(getattr(row, "sender_address", None)),
          "recipients:", list(row.recipients.values_list("email", flat=True))
          if row else None)
    assert row is None, "a never-sent draft outlived the account"


# --- 4. celery prerun binding for tasks whose first arg is not a job id ---- #
def test_prerun_binding_for_non_job_tasks():
    from apps.core import logging as zen_logging
    from config.celery import _bind_correlation, _clear_correlation

    _clear_correlation()

    class FakeRequest:
        headers = {}

    class FakeTask:
        request = FakeRequest()

    # generate_thumbnails_task(document_id, ...)
    _bind_correlation(task=FakeTask(), args=["11111111-2222-3333-4444-555555555555"])
    print("job_id bound for generate_thumbnails_task:",
          zen_logging.job_id_var.get())
    _clear_correlation()

    # worker_heartbeat() — no args at all
    _bind_correlation(task=FakeTask(), args=[])
    print("job_id bound for worker_heartbeat:", repr(zen_logging.job_id_var.get()))
    print("request_id bound for worker_heartbeat:",
          repr(zen_logging.request_id_var.get()))
    _clear_correlation()


# --- 5. streaming response: ids are gone before the body is produced ------- #
def test_streaming_body_runs_without_the_correlation_ids(api, uploaded_doc):
    from apps.core.logging import request_id_var

    seen = []
    resp = api.get(f"/api/documents/{uploaded_doc['id']}/content/")
    print("streaming?", resp.streaming, "X-Request-ID:", resp.get("X-Request-ID"))
    if getattr(resp, "streaming", False):
        for _chunk in resp.streaming_content:
            seen.append(request_id_var.get())
            break
    print("request_id visible while streaming:", repr(seen[0] if seen else "n/a"))


# --- 6. admin IP allowlist and a spoofed X-Forwarded-For ------------------- #
def test_admin_ip_gate_accepts_a_spoofed_forwarded_for(client, settings):
    settings.DEBUG = False
    settings.ADMIN_ENABLED = True
    settings.ADMIN_URL_PATH = "admin/"
    settings.ADMIN_IP_ALLOWLIST = ["10.9.9.9"]

    from django.urls import clear_url_caches
    clear_url_caches()

    blocked = client.get("/admin/")
    spoofed = client.get("/admin/", HTTP_X_FORWARDED_FOR="10.9.9.9")
    print("no header ->", blocked.status_code, " spoofed XFF ->",
          spoofed.status_code)
    assert spoofed.status_code == blocked.status_code, (
        "X-Forwarded-For alone changed the admin gate's answer")
