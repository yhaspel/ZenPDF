"""Cross-principal isolation, swept across every endpoint (phase-10 §10.1).

The per-phase suites each assert isolation for the routes they added. This one
asks the question the other way round: **enumerate the URL table** and prove
that nothing reachable with an id in it can be reached by the wrong principal.

That direction matters because the failure mode is a route somebody added
without thinking about it — which a test written alongside that route cannot
catch, and a test that walks the resolver can.

Two rules from §21.2, and the sweep checks both:

* another principal's object answers **404, never 403** — "forbidden" confirms
  the id is real;
* a **guest** and an **account** are equally strangers to each other. The
  first cut of `owned_by` read `owner=None` for a guest, which matched every
  other guest's rows.
"""
from __future__ import annotations

import pytest
from django.urls import get_resolver

pytestmark = pytest.mark.django_db

#: Routes that take an id but are *meant* to be reachable by a stranger — the
#: token in the URL is the credential, not the session. Each one is listed with
#: the reason it is here, so this set cannot grow by accident.
PUBLIC_BY_TOKEN = {
    "public/sign/<str:token>/": "the signing ceremony — the token is the capability",
    "public/sign/<str:token>/consent/": "same",
    "public/sign/<str:token>/content/": "same",
    "public/sign/<str:token>/pages/<int:page>/": "same",
    "public/sign/<str:token>/fields/": "same",
    "public/sign/<str:token>/complete/": "same",
    "public/sign/<str:token>/decline/": "same",
    "public/sign/<str:token>/report/": "same",
    "public/sign/<str:token>/download/<str:what>/": "same",
    "mail/unsubscribe/<str:token>/": "the link in a mail footer, clicked by its owner",
}


def _verify(user):
    """Sending needs a confirmed address (§9B); these tests are about tokens."""
    user.email_verified = True
    user.save(update_fields=["email_verified"])


def _routes():
    for entry in get_resolver().url_patterns:
        for pattern in getattr(entry, "url_patterns", [entry]):
            yield str(pattern.pattern), pattern.callback


def test_every_id_bearing_route_is_scoped_to_its_principal(
        api, other_api, guest, other_guest, fixture_bytes, uploaded_doc):
    """One document, four callers: its owner, another account, a guest, and a
    second guest. Only the first may see it."""
    doc_id = uploaded_doc["id"]
    for client, who in ((other_api, "another account"), (guest, "a guest"),
                        (other_guest, "another guest")):
        resp = client.get(f"/api/documents/{doc_id}/")
        assert resp.status_code == 404, (
            f"{who} could see somebody else's document ({resp.status_code})"
        )


def test_a_guests_document_is_invisible_to_every_other_principal(
        guest, other_guest, api, guest_doc):
    """`owned_by` once read `owner=None` for a guest, which matched every other
    guest's rows — the bug this asserts against."""
    doc_id = guest_doc["id"]
    assert other_guest.get(f"/api/documents/{doc_id}/").status_code == 404
    assert api.get(f"/api/documents/{doc_id}/").status_code == 404
    assert guest.get(f"/api/documents/{doc_id}/").status_code == 200


def test_no_route_answers_403_for_somebody_elses_object(other_api, uploaded_doc):
    """404, never 403: the second confirms the id exists (§21.2)."""
    doc_id = uploaded_doc["id"]
    for path in (
        f"/api/documents/{doc_id}/",
        f"/api/documents/{doc_id}/versions/",
        f"/api/documents/{doc_id}/content/",
        f"/api/documents/{doc_id}/pages/",
        f"/api/documents/{doc_id}/pages/1/thumbnail/",
    ):
        assert other_api.get(path).status_code == 404, path


def test_every_read_route_added_since_phase_1_is_scoped(other_api, api,
                                                        uploaded_doc, user):
    """The per-phase suites each assert isolation for the routes they added.
    This asks it once, for all of them, from the other account's side."""
    from apps.esign.models import SavedSignature, SignRequest

    user.email_verified = True
    user.save(update_fields=["email_verified"])
    request = SignRequest.objects.create(owner=user, title="Private",
                                         document_id=uploaded_doc["id"])
    signature = SavedSignature.objects.create(user=user, storage_key="x/y.png")
    folder = api.post("/api/folders/", {"name": "Mine"}, format="json").json()
    job = api.post(
        f"/api/documents/{uploaded_doc['id']}/operations/",
        {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90}},
        format="json",
    ).json()

    for path in (
        f"/api/sign-requests/{request.id}/",
        f"/api/sign-requests/{request.id}/audit/",
        f"/api/signatures/{signature.id}/",
        f"/api/folders/{folder['id']}/",
        f"/api/jobs/{job['id']}/",
        f"/api/jobs/{job['id']}/download/",
        f"/api/documents/{uploaded_doc['id']}/pages/1/thumbnail/",
    ):
        code = other_api.get(path).status_code
        assert code == 404, f"{path} answered {code} to another account"


def test_jobs_are_scoped_too(api, other_api, guest, uploaded_doc):
    """A job id is a handle on somebody's work in progress, including its
    parameters and its error messages."""
    resp = api.post(
        f"/api/documents/{uploaded_doc['id']}/operations/",
        {"type": "rotate_pages", "params": {"pages": [0], "degrees": 90}},
        format="json",
    )
    job_id = resp.json()["id"]
    assert other_api.get(f"/api/jobs/{job_id}/").status_code == 404
    assert guest.get(f"/api/jobs/{job_id}/").status_code == 404
    assert api.get(f"/api/jobs/{job_id}/").status_code == 200


def test_a_signing_token_belongs_to_one_recipient_only(api, uploaded_doc, anon,
                                                       user):
    """Two recipients on one request get two tokens, and neither may act as
    the other — the token names the person, not the envelope."""
    from apps.esign.models import Recipient, SignRequest

    _verify(user)

    request = api.post("/api/sign-requests/", {"document": uploaded_doc["id"]},
                       format="json").json()
    api.patch(
        f"/api/sign-requests/{request['id']}/",
        {"recipients": [
            {"email": "first@example.com", "role": "signer", "order": 1},
            {"email": "second@example.com", "role": "signer", "order": 2},
        ]},
        format="json",
    )
    people = {r.email: r for r in Recipient.objects.filter(
        sign_request_id=request["id"])}
    fields = [{"recipient_id": str(people["first@example.com"].id), "page": 0,
               "x": 0.1, "y": 0.1, "w": 0.2, "h": 0.05, "type": "signature",
               "required": True},
              {"recipient_id": str(people["second@example.com"].id), "page": 0,
               "x": 0.5, "y": 0.1, "w": 0.2, "h": 0.05, "type": "signature",
               "required": True}]
    api.patch(f"/api/sign-requests/{request['id']}/", {"fields": fields},
              format="json")
    api.post(f"/api/sign-requests/{request['id']}/send/", format="json")

    first, second = people["first@example.com"], people["second@example.com"]
    first.refresh_from_db()
    second.refresh_from_db()

    # The second signer's own field, submitted with the first signer's token.
    field_id = str(second.fields.first().id)
    resp = anon.post(f"/api/public/sign/{first.token}/fields/",
                     {"field_id": field_id, "value": "x"}, format="json")
    assert resp.status_code in (400, 403, 404), resp.status_code
    assert SignRequest.objects.get(id=request["id"]).status == "sent"


def _sent_token(api, uploaded_doc, user, email="solo@example.com"):
    """A sent request with one text field, and the recipient's token.

    A text field rather than a signature because these tests are about the
    token state machine, and a signature needs an image the API has to store.
    """
    from apps.esign.models import Recipient

    _verify(user)
    request = api.post("/api/sign-requests/", {"document": uploaded_doc["id"]},
                       format="json").json()
    api.patch(f"/api/sign-requests/{request['id']}/",
              {"recipients": [{"email": email, "role": "signer", "order": 1}]},
              format="json")
    recipient = Recipient.objects.get(sign_request_id=request["id"])
    api.patch(
        f"/api/sign-requests/{request['id']}/",
        {"fields": [{"recipient_id": str(recipient.id), "page": 0, "x": 0.1,
                     "y": 0.1, "w": 0.2, "h": 0.05, "type": "text",
                     "required": True}]},
        format="json",
    )
    api.post(f"/api/sign-requests/{request['id']}/send/", format="json")
    recipient.refresh_from_db()
    return request["id"], recipient


def test_a_completed_recipient_cannot_sign_twice(api, uploaded_doc, anon, user):
    """Otherwise an envelope's history stops meaning anything."""
    from apps.esign.models import AuditEvent

    request_id, recipient = _sent_token(api, uploaded_doc, user)
    token = recipient.token
    assert anon.get(f"/api/public/sign/{token}/").status_code == 200

    field_id = str(recipient.fields.first().id)
    anon.post(f"/api/public/sign/{token}/consent/", {"agree": True},
              format="json")
    anon.post(f"/api/public/sign/{token}/fields/",
              {"field_id": field_id, "value": "x"}, format="json")
    assert anon.post(f"/api/public/sign/{token}/complete/",
                     format="json").status_code == 200

    replay = anon.post(f"/api/public/sign/{token}/complete/", format="json")
    assert replay.status_code >= 400, replay.status_code
    signed = AuditEvent.objects.filter(sign_request_id=request_id,
                                       type="signed").count()
    assert signed == 1, f"{signed} signature events for one signer"

    # …and the link still *opens*: a completed envelope has to stay reachable
    # by the people who signed it (ESIGN retention).
    assert anon.get(f"/api/public/sign/{token}/").status_code == 200


def test_a_canceled_requests_token_stops_working(api, uploaded_doc, anon, user):
    request_id, recipient = _sent_token(api, uploaded_doc, user,
                                        email="cancelled@example.com")
    token = recipient.token
    assert anon.get(f"/api/public/sign/{token}/").status_code == 200

    api.post(f"/api/sign-requests/{request_id}/cancel/", format="json")
    # 410 Gone: the link was real and is not any more, which is the honest
    # thing to tell somebody who was legitimately sent it.
    assert anon.get(f"/api/public/sign/{token}/").status_code == 410
    assert anon.post(f"/api/public/sign/{token}/complete/",
                     format="json").status_code == 410


def test_a_forged_or_truncated_token_is_refused_everywhere(anon):
    for token in ("", "x", "0" * 43, "../../etc/passwd", "%00"):
        resp = anon.get(f"/api/public/sign/{token}/")
        assert resp.status_code in (401, 404), (token, resp.status_code)


def test_the_public_token_routes_are_the_only_unauthenticated_id_routes():
    """A new route that takes an id and forgets to scope it should fail here
    rather than in production."""
    from rest_framework.permissions import AllowAny

    unguarded = []
    for route, callback in _routes():
        if "<" not in route:
            continue
        view = getattr(callback, "cls", None) or getattr(callback, "view_class", None)
        if view is None:
            continue
        permissions = getattr(view, "permission_classes", [])
        if AllowAny in permissions and route not in PUBLIC_BY_TOKEN:
            unguarded.append(route)
    assert not unguarded, (
        "these id-bearing routes are open to anyone; if that is deliberate, "
        f"add them to PUBLIC_BY_TOKEN with a reason: {unguarded}"
    )
