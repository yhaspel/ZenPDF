import pytest

pytestmark = pytest.mark.django_db


def _rotate(api, doc_id, base_seq=1):
    r = api.post(f"/api/documents/{doc_id}/operations/",
                 {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90},
                  "base_version_seq": base_seq}, format="json")
    assert r.status_code == 202
    return api.get(f"/api/jobs/{r.json()['id']}/").json()


def test_version_history_and_revert(api, uploaded_doc):
    doc_id = uploaded_doc["id"]
    job = _rotate(api, doc_id)
    assert job["status"] == "succeeded"
    assert job["result"]["seq"] == 2

    versions = api.get(f"/api/documents/{doc_id}/versions/").json()["results"]
    labels = [v["label"] for v in versions]
    assert "Original" in labels
    assert "Rotated 1 page(s)" in labels

    # revert to v1
    r = api.post(f"/api/documents/{doc_id}/versions/1/revert/", format="json")
    assert r.status_code == 202
    j = api.get(f"/api/jobs/{r.json()['id']}/").json()
    assert j["status"] == "succeeded"
    assert j["result"]["seq"] == 3

    detail = api.get(f"/api/documents/{doc_id}/").json()
    assert detail["current_version"]["seq"] == 3
    assert detail["current_version"]["label"] == "Reverted to v1"


def test_trash_restore_purge_frees_quota(api, uploaded_doc, user):
    doc_id = uploaded_doc["id"]
    user.refresh_from_db()
    used_before = user.storage_bytes_used
    assert used_before > 0

    # trash
    assert api.delete(f"/api/documents/{doc_id}/").status_code == 204
    assert api.get("/api/documents/").json()["count"] == 0
    assert api.get("/api/documents/?trashed=true").json()["count"] == 1

    # restore
    assert api.post(f"/api/documents/{doc_id}/restore/").status_code == 200
    assert api.get("/api/documents/").json()["count"] == 1

    # trash again + permanent purge
    api.delete(f"/api/documents/{doc_id}/")
    assert api.delete(f"/api/documents/{doc_id}/?permanent=true").status_code == 204
    user.refresh_from_db()
    assert user.storage_bytes_used == 0


def test_permanent_delete_requires_trash_first(api, uploaded_doc):
    doc_id = uploaded_doc["id"]
    r = api.delete(f"/api/documents/{doc_id}/?permanent=true")
    assert r.status_code == 400


# --------------------------------------------------------------------------- #
# A document that cannot be deleted says so where the user looks
# (queue, 2026-08-02 — the UI half)
# --------------------------------------------------------------------------- #
def _with_sign_request(api, doc_id, user):
    """A sent request pointing at this document, made the way the API makes one."""
    user.email_verified = True
    user.save(update_fields=["email_verified"])
    created = api.post("/api/sign-requests/",
                       {"document": doc_id, "title": "Offer"}, format="json")
    assert created.status_code == 201, created.content
    request_id = created.json()["id"]
    people = api.patch(f"/api/sign-requests/{request_id}/",
                       {"recipients": [{"email": "signer@example.com",
                                        "name": "Sam", "role": "signer",
                                        "order": 1}]},
                       format="json").json()["recipients"]
    api.patch(f"/api/sign-requests/{request_id}/",
              {"fields": [{"recipient_id": people[0]["id"], "page": 0,
                           "x": 0.1, "y": 0.7, "w": 0.3, "h": 0.08,
                           "type": "signature", "required": True,
                           "label": "Sign here"}]}, format="json")
    assert api.post(f"/api/sign-requests/{request_id}/send/",
                    format="json").status_code == 200
    return request_id


def test_has_sign_requests_is_false_for_an_ordinary_document(api, uploaded_doc):
    body = api.get(f"/api/documents/{uploaded_doc['id']}/").json()
    assert body["has_sign_requests"] is False
    listed = api.get("/api/documents/").json()["results"][0]
    assert listed["has_sign_requests"] is False


def test_has_sign_requests_is_true_once_one_points_at_it(api, uploaded_doc, user):
    _with_sign_request(api, uploaded_doc["id"], user)

    body = api.get(f"/api/documents/{uploaded_doc['id']}/").json()
    assert body["has_sign_requests"] is True

    api.delete(f"/api/documents/{uploaded_doc['id']}/")
    trashed = api.get("/api/documents/?trashed=true").json()["results"][0]
    assert trashed["has_sign_requests"] is True, (
        "the trash view is the one that has to know — it is where "
        "'Delete forever' is offered"
    )


def test_the_flag_agrees_with_what_purge_actually_does(api, uploaded_doc, user):
    """The flag exists to predict the refusal. If the two ever disagreed, the
    UI would either hide a working action or offer one that always fails."""
    _with_sign_request(api, uploaded_doc["id"], user)
    api.delete(f"/api/documents/{uploaded_doc['id']}/")

    listed = api.get("/api/documents/?trashed=true").json()["results"][0]
    refused = api.delete(f"/api/documents/{uploaded_doc['id']}/?permanent=true")

    assert listed["has_sign_requests"] is True
    assert refused.status_code == 400
    assert "sent for signature" in refused.json()["error"]["message"].lower()


def test_the_list_costs_the_same_number_of_queries_however_many_rows(
        api, fixture_bytes):
    """Fifty rows must not become fifty-one queries.

    Asserted as a *shape* rather than a magic number: the count is measured
    once with two documents and again with six, and the two must be equal. A
    fixed number would pin today's unrelated queries as well and would have to
    be renegotiated every time anything else on this path changed — and the
    property that matters here is only that nothing grows per row. A per-row
    `.exists()` would show up as +4.

    The library list is the single most-run query in the product (§10.2).
    """
    from django.core.files.uploadedfile import SimpleUploadedFile
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    def upload(name):
        assert api.post("/api/documents/",
                        {"file": SimpleUploadedFile(name, fixture_bytes("text.pdf"),
                                                    content_type="application/pdf")},
                        format="multipart").status_code == 201

    def count_queries_for_the_list() -> tuple[int, dict]:
        with CaptureQueriesContext(connection) as captured:
            body = api.get("/api/documents/").json()
        return len(captured), body

    upload("first.pdf")
    upload("second.pdf")
    small, small_body = count_queries_for_the_list()
    assert small_body["count"] == 2

    for i in range(4):
        upload(f"more-{i}.pdf")
    large, large_body = count_queries_for_the_list()
    assert large_body["count"] == 6

    assert large == small, (
        f"listing 6 documents cost {large} queries and listing 2 cost {small}; "
        f"`has_sign_requests` is being resolved per row"
    )
    assert all(row["has_sign_requests"] is False for row in large_body["results"])
