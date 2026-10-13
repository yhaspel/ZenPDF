"""The refusals and fallbacks in `esign.views` that the happy-path loop skips.

`test_sign_api.py` walks builder → send → ceremony → finalize → verify. What it
does not exercise is every door that has to stay *shut*: the saved-signature
endpoint handed something that is not a signature, a draft deleted after it was
sent, a request nudged before it was sent, a signer acting before their turn, a
checkbox posted as `"on"`, a verify upload with no file in it. Each of these is
a sentence somebody reads, so each one is pinned here — a 500 in any of them
would hand the person a stack trace instead.
"""
import base64
import copy
from unittest import mock

import fitz
import pytest
from django.core import mail
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone

from apps.core import mail as core_mail
from apps.esign.models import Recipient, SavedSignature, SignField, SignRequest
from apps.pdf_engine.storage import get_storage

pytestmark = pytest.mark.django_db


def _ink() -> bytes:
    doc = fitz.open()
    page = doc.new_page(width=300, height=120)
    page.draw_line((40, 80), (260, 50), width=3)
    data = page.get_pixmap(alpha=True).tobytes("png")
    doc.close()
    return data


def _data_url(data: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(data).decode()


@pytest.fixture(autouse=True)
def _verified(user):
    user.email_verified = True
    user.save(update_fields=["email_verified"])
    return user


@pytest.fixture
def draft(api, uploaded_doc):
    resp = api.post("/api/sign-requests/",
                    {"document": uploaded_doc["id"], "title": "Offer",
                     "message": "Please sign."}, format="json")
    assert resp.status_code == 201, resp.content
    return resp.json()


def _recipients(api, request_id, people):
    resp = api.patch(f"/api/sign-requests/{request_id}/",
                     {"recipients": people}, format="json")
    assert resp.status_code == 200, resp.content
    return resp.json()["recipients"]


def _fields(api, request_id, fields):
    resp = api.patch(f"/api/sign-requests/{request_id}/",
                     {"fields": fields}, format="json")
    assert resp.status_code == 200, resp.content
    return resp.json()["fields_"]


def _field(recipient_id, type_="signature", **extra):
    return {"recipient_id": recipient_id, "page": 0, "x": 0.1, "y": 0.7,
            "w": 0.3, "h": 0.08, "type": type_, "required": True,
            "label": type_, **extra}


def _token(request_id, email) -> str:
    return Recipient.objects.get(sign_request_id=request_id, email=email).token


def _send(api, request_id):
    resp = api.post(f"/api/sign-requests/{request_id}/send/", format="json")
    assert resp.status_code == 200, resp.content
    return resp.json()


@pytest.fixture
def sent(api, draft):
    """One signer with a signature field, sent."""
    people = _recipients(api, draft["id"], [
        {"email": "signer@example.com", "name": "Sam", "role": "signer",
         "order": 1}])
    _fields(api, draft["id"], [_field(people[0]["id"])])
    return _send(api, draft["id"])


def _sign_through(anon, token):
    meta = anon.get(f"/api/public/sign/{token}/").json()
    anon.post(f"/api/public/sign/{token}/consent/", {"agree": True},
              format="json")
    for field in meta["fields"]:
        if field["type"] == "signature":
            anon.post(f"/api/public/sign/{token}/fields/",
                      {"field_id": field["id"],
                       "signature_image": _data_url(_ink())}, format="json")
    resp = anon.post(f"/api/public/sign/{token}/complete/", format="json")
    assert resp.status_code == 200, resp.content
    return resp.json()


@pytest.fixture
def completed(api, anon, sent):
    _sign_through(anon, _token(sent["id"], "signer@example.com"))
    sign_request = SignRequest.objects.get(id=sent["id"])
    assert sign_request.status == SignRequest.Status.COMPLETED
    return sign_request


# --------------------------------------------------------------------------- #
# Saved signatures
# --------------------------------------------------------------------------- #
def test_a_saved_signature_must_be_a_signature_or_initials(api):
    resp = api.post("/api/signatures/",
                    {"kind": "stamp", "method": "type", "text": "Ada"},
                    format="json")
    assert resp.status_code == 400
    assert "kind must be" in resp.json()["error"]["message"]
    assert SavedSignature.objects.count() == 0


def test_an_image_the_normalizer_rejects_is_a_400_not_a_500(api):
    from apps.core.assets import ImageRejected

    with mock.patch("apps.esign.views.SG.normalize_signature",
                    side_effect=ImageRejected("Only PNG and JPEG images are "
                                              "supported.")):
        resp = api.post("/api/signatures/",
                        {"method": "draw", "image": _data_url(_ink())},
                        format="json")
    assert resp.status_code == 400
    assert "Only PNG and JPEG" in resp.json()["error"]["message"]


def test_an_upload_over_the_tier_cap_is_refused_before_it_is_decoded(api, settings):
    """The size is checked on the upload object, not on decoded pixels — so a
    file the tier will not accept never reaches the per-pixel pass."""
    tiers = copy.deepcopy(settings.TIERS)
    tiers["free"]["max_image_upload_mb"] = 1
    settings.TIERS = tiers

    too_big = b"\x89PNG\r\n\x1a\n" + b"\x00" * (1024 * 1024)
    with mock.patch("apps.esign.views.SG.normalize_signature") as normalize:
        resp = api.post("/api/signatures/",
                        {"method": "draw",
                         "file": SimpleUploadedFile("sig.png", too_big,
                                                    content_type="image/png")},
                        format="multipart")
    assert resp.status_code == 400, resp.content
    assert "1 MB or smaller" in resp.json()["error"]["message"]
    normalize.assert_not_called()


def test_drawing_nothing_is_told_so(api):
    resp = api.post("/api/signatures/", {"method": "draw"}, format="json")
    assert resp.status_code == 400
    assert "No signature image was sent" in resp.json()["error"]["message"]


def test_an_image_over_the_hard_ceiling_is_refused(api, monkeypatch):
    from apps.esign import views

    png = _ink()
    monkeypatch.setattr(views, "MAX_SIGNATURE_IMAGE_BYTES", len(png) - 1)
    resp = api.post("/api/signatures/",
                    {"method": "draw", "image": _data_url(png)}, format="json")
    assert resp.status_code == 400
    assert "too large" in resp.json()["error"]["message"]


@pytest.mark.parametrize("image", [
    "data:image/png;base64,%%%not-base64%%%",
    "@@@ raw garbage that is not base64 @@@",
])
def test_an_unreadable_data_url_is_a_400(api, image):
    resp = api.post("/api/signatures/", {"method": "draw", "image": image},
                    format="json")
    assert resp.status_code == 400
    assert "could not be read" in resp.json()["error"]["message"]


def test_a_bad_font_on_the_render_preview_is_a_400(anon):
    resp = anon.post("/api/signatures/render/",
                     {"text": "Ada", "font": "comic-sans"}, format="json")
    assert resp.status_code == 400
    assert "Unknown signature font" in resp.json()["error"]["message"]


def test_deleting_a_signature_whose_image_is_already_gone_still_deletes(api):
    created = api.post("/api/signatures/",
                       {"method": "type", "text": "Ada", "font": "caveat"},
                       format="json").json()
    key = SavedSignature.objects.get(id=created["id"]).storage_key
    get_storage().delete(key)

    resp = api.delete(f"/api/signatures/{created['id']}/")
    assert resp.status_code == 204, resp.content
    assert not SavedSignature.objects.filter(id=created["id"]).exists()


def test_deleting_a_signature_credits_its_bytes_back(api, user):
    before = type(user).objects.get(pk=user.pk).storage_bytes_used
    created = api.post("/api/signatures/",
                       {"method": "type", "text": "Ada", "font": "caveat"},
                       format="json").json()
    assert type(user).objects.get(pk=user.pk).storage_bytes_used > before

    api.delete(f"/api/signatures/{created['id']}/")
    assert type(user).objects.get(pk=user.pk).storage_bytes_used == before


@pytest.mark.parametrize("view_name", [
    "SignatureListView", "SignatureDetailView", "SignRequestListView",
])
def test_schema_generation_does_not_need_a_signed_in_user(view_name):
    """drf-spectacular instantiates the view with no principal; the queryset
    must answer empty rather than try to filter on `AnonymousUser`."""
    from django.contrib.auth.models import AnonymousUser
    from rest_framework.request import Request
    from rest_framework.test import APIRequestFactory

    from apps.esign import views

    view = getattr(views, view_name)()
    view.request = Request(APIRequestFactory().get("/"))
    view.request.user = AnonymousUser()
    view.swagger_fake_view = True
    assert list(view.get_queryset()) == []


# --------------------------------------------------------------------------- #
# Sign requests — the builder's refusals
# --------------------------------------------------------------------------- #
def test_a_draft_can_be_deleted_but_a_sent_request_cannot(api, draft, sent):
    other = api.post("/api/sign-requests/",
                     {"document": draft["document"], "title": "Scratch"},
                     format="json").json()
    assert api.delete(f"/api/sign-requests/{other['id']}/").status_code == 204
    assert api.get(f"/api/sign-requests/{other['id']}/").status_code == 404

    resp = api.delete(f"/api/sign-requests/{sent['id']}/")
    assert resp.status_code == 400
    assert "Only a draft can be deleted" in resp.json()["error"]["message"]
    assert SignRequest.objects.filter(id=sent["id"]).exists()


def test_the_list_shows_only_the_callers_own_requests(api, other_api, draft):
    mine = api.get("/api/sign-requests/")
    assert mine.status_code == 200, mine.content
    assert [r["id"] for r in mine.json()["results"]] == [draft["id"]]
    assert mine.json()["results"][0]["document_title"] == "text"

    theirs = other_api.get("/api/sign-requests/")
    assert theirs.status_code == 200
    assert theirs.json()["results"] == []


def test_the_recipient_cap_is_checked_again_at_send(api, draft, settings):
    """The draft-time check is the friendly one; this is the one that holds
    if the cap was lowered after the people were added."""
    people = [{"email": f"s{i}@example.com", "role": "signer", "order": 1}
              for i in range(3)]
    rows = _recipients(api, draft["id"], people)
    _fields(api, draft["id"], [_field(r["id"]) for r in rows])
    settings.MAX_RECIPIENTS_PER_REQUEST = 2
    mail.outbox.clear()

    resp = api.post(f"/api/sign-requests/{draft['id']}/send/", format="json")
    assert resp.status_code == 400
    assert "at most 2 people" in resp.json()["error"]["message"]
    assert mail.outbox == []
    assert SignRequest.objects.get(id=draft["id"]).status == "draft"


def test_a_password_protected_document_cannot_be_sent_for_signature(api,
                                                                     fixture_bytes):
    upload = SimpleUploadedFile("encrypted.pdf", fixture_bytes("encrypted.pdf"),
                                content_type="application/pdf")
    doc = api.post("/api/documents/", {"file": upload}, format="multipart").json()
    assert doc["is_encrypted"] is True

    resp = api.post("/api/sign-requests/", {"document": doc["id"]}, format="json")
    assert resp.status_code == 400
    assert "password-protected" in resp.json()["error"]["message"]
    assert SignRequest.objects.count() == 0


def test_a_message_is_cut_at_five_thousand_characters(api, draft):
    resp = api.patch(f"/api/sign-requests/{draft['id']}/",
                     {"message": "m" * 6000}, format="json")
    assert resp.status_code == 200, resp.content
    assert len(resp.json()["message"]) == 5000


@pytest.mark.parametrize("value, expected", [(500, 90), (-5, 0), ("7", 7)])
def test_the_reminder_cadence_is_clamped_to_its_range(api, draft, value, expected):
    resp = api.patch(f"/api/sign-requests/{draft['id']}/",
                     {"reminder_every_days": value}, format="json")
    assert resp.status_code == 200, resp.content
    assert resp.json()["reminder_every_days"] == expected


def test_a_reminder_cadence_that_is_not_a_number_is_a_400(api, draft):
    resp = api.patch(f"/api/sign-requests/{draft['id']}/",
                     {"reminder_every_days": "weekly"}, format="json")
    assert resp.status_code == 400
    assert "reminder_every_days must be a whole number" in \
        resp.json()["error"]["message"]


def test_the_expiry_is_clamped_to_a_year(api, draft):
    resp = api.patch(f"/api/sign-requests/{draft['id']}/",
                     {"expires_in_days": 5000}, format="json")
    assert resp.status_code == 200
    expires_at = SignRequest.objects.get(id=draft["id"]).expires_at
    assert (expires_at - timezone.now()).days in (364, 365)


def test_a_layout_cannot_exceed_the_field_cap(api, draft):
    from apps.esign.views import MAX_FIELDS

    people = _recipients(api, draft["id"], [
        {"email": "s@example.com", "role": "signer", "order": 1}])
    resp = api.patch(f"/api/sign-requests/{draft['id']}/",
                     {"fields": [_field(people[0]["id"])] * (MAX_FIELDS + 1)},
                     format="json")
    assert resp.status_code == 400
    assert f"At most {MAX_FIELDS} fields" in resp.json()["error"]["message"]
    assert SignField.objects.filter(sign_request_id=draft["id"]).count() == 0


def test_fields_must_be_a_list(api, draft):
    resp = api.patch(f"/api/sign-requests/{draft['id']}/",
                     {"fields": {"recipient_id": "x"}}, format="json")
    assert resp.status_code == 400
    assert "fields" in resp.json()["error"]["message"]


def test_a_request_cannot_be_sent_twice(api, sent):
    mail.outbox.clear()
    resp = api.post(f"/api/sign-requests/{sent['id']}/send/", format="json")
    assert resp.status_code == 400
    assert "already been sent" in resp.json()["error"]["message"]
    assert mail.outbox == [], "the signer was invited a second time"


def test_a_document_with_no_content_cannot_be_sent(api, draft):
    from apps.documents.models import Document

    people = _recipients(api, draft["id"], [
        {"email": "s@example.com", "role": "signer", "order": 1}])
    _fields(api, draft["id"], [_field(people[0]["id"])])
    Document.objects.filter(id=draft["document"]).update(current_version=None)

    resp = api.post(f"/api/sign-requests/{draft['id']}/send/", format="json")
    assert resp.status_code == 400
    assert "no content to send" in resp.json()["error"]["message"]
    assert SignRequest.objects.get(id=draft["id"]).status == "draft"


def test_a_finished_request_cannot_be_canceled(api, uploaded_doc, completed):
    fresh = api.post("/api/sign-requests/", {"document": uploaded_doc["id"]},
                     format="json").json()
    first = api.post(f"/api/sign-requests/{fresh['id']}/cancel/", format="json")
    assert first.status_code == 200
    assert first.json()["status"] == "canceled"

    again = api.post(f"/api/sign-requests/{fresh['id']}/cancel/", format="json")
    assert again.status_code == 400
    assert "already finished" in again.json()["error"]["message"]

    done = api.post(f"/api/sign-requests/{completed.id}/cancel/", format="json")
    assert done.status_code == 400
    assert "already finished" in done.json()["error"]["message"]
    completed.refresh_from_db()
    assert completed.status == SignRequest.Status.COMPLETED


def test_only_a_sent_request_can_be_nudged(api, uploaded_doc, completed):
    fresh = api.post("/api/sign-requests/", {"document": uploaded_doc["id"]},
                     format="json").json()
    for request_id in (fresh["id"], completed.id):
        resp = api.post(f"/api/sign-requests/{request_id}/remind/", format="json")
        assert resp.status_code == 400
        assert "Only a sent request can be nudged" in \
            resp.json()["error"]["message"]


def test_a_nudge_to_a_suppressed_address_is_reported_as_skipped(api, sent):
    """The reminder did not go, so it must not be recorded as a reminder and
    must not burn the once-a-day allowance."""
    Recipient.objects.filter(sign_request_id=sent["id"]).update(
        last_notified_at=timezone.now() - timezone.timedelta(days=2))
    core_mail.suppress("signer@example.com")
    mail.outbox.clear()

    resp = api.post(f"/api/sign-requests/{sent['id']}/remind/", format="json")
    assert resp.status_code == 200
    assert resp.json() == {"reminded": [], "skipped": ["signer@example.com"]}
    assert mail.outbox == []
    assert not SignRequest.objects.get(id=sent["id"]).audit_events.filter(
        type="reminder_sent").exists()


def test_the_owner_reads_the_audit_trail_with_its_chain(api, sent):
    resp = api.get(f"/api/sign-requests/{sent['id']}/audit/")
    assert resp.status_code == 200
    body = resp.json()
    assert [e["type"] for e in body["events"]] == ["created", "sent"]
    assert body["chain"]["intact"] is True
    assert body["chain"]["count"] == 2
    assert body["chain"]["head"] == body["events"][-1]["event_hash"]


def test_the_owner_cannot_download_a_file_that_is_not_ready(api, sent):
    for what in ("final", "certificate"):
        resp = api.get(f"/api/sign-requests/{sent['id']}/download/{what}/")
        assert resp.status_code == 410, resp.content
        assert "not ready yet" in resp.json()["error"]["message"]


def test_the_owner_downloads_the_sealed_file_and_it_is_recorded(api, completed):
    resp = api.get(f"/api/sign-requests/{completed.id}/download/final/")
    assert resp.status_code == 200
    assert resp["Content-Type"] == "application/pdf"
    assert resp["Content-Disposition"] == 'attachment; filename="Offer.pdf"'
    assert resp.content[:5] == b"%PDF-"

    cert = api.get(f"/api/sign-requests/{completed.id}/download/certificate/")
    assert cert.status_code == 200
    assert completed.envelope_code in cert["Content-Disposition"]
    assert completed.audit_events.filter(type="downloaded").count() == 2


def test_another_account_cannot_download_or_delete_a_request(other_api, sent,
                                                              completed):
    assert other_api.get(
        f"/api/sign-requests/{completed.id}/download/final/").status_code == 404
    assert other_api.delete(f"/api/sign-requests/{sent['id']}/").status_code == 404
    assert SignRequest.objects.filter(id=sent["id"]).exists()


# --------------------------------------------------------------------------- #
# The ceremony — the signer's refusals
# --------------------------------------------------------------------------- #
def test_a_link_to_a_draft_does_not_work_yet(api, draft, anon):
    _recipients(api, draft["id"], [
        {"email": "early@example.com", "role": "signer", "order": 1}])
    token = _token(draft["id"], "early@example.com")

    resp = anon.get(f"/api/public/sign/{token}/")
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "token_invalid"
    assert "not been sent yet" in resp.json()["error"]["message"]


def test_a_later_signer_cannot_act_before_their_turn(api, draft, anon):
    people = _recipients(api, draft["id"], [
        {"email": "first@example.com", "role": "signer", "order": 1},
        {"email": "second@example.com", "role": "signer", "order": 2},
    ])
    fields = _fields(api, draft["id"], [_field(people[0]["id"]),
                                        _field(people[1]["id"])])
    _send(api, draft["id"])
    second = _token(draft["id"], "second@example.com")
    assert anon.post(f"/api/public/sign/{second}/consent/", {"agree": True},
                     format="json").status_code == 200

    resp = anon.post(f"/api/public/sign/{second}/fields/",
                     {"field_id": fields[1]["id"],
                      "signature_image": _data_url(_ink())}, format="json")
    assert resp.status_code == 410
    assert "not your turn" in resp.json()["error"]["message"]
    assert not SignField.objects.get(id=fields[1]["id"]).image_key


def test_a_request_whose_document_was_detached_says_so(sent, anon):
    """§10.1: a closed account detaches the version. The link must answer
    with a sentence, not a 500 on a null key."""
    SignRequest.objects.filter(id=sent["id"]).update(source_version=None)
    token = _token(sent["id"], "signer@example.com")

    for path in ("content/", "pages/0/"):
        resp = anon.get(f"/api/public/sign/{token}/{path}")
        assert resp.status_code == 410, path
        assert "no document yet" in resp.json()["error"]["message"]


def _png_width(content: bytes) -> int:
    return fitz.Pixmap(content).width


def test_a_page_width_that_is_not_a_number_falls_back_to_the_default(sent, anon):
    token = _token(sent["id"], "signer@example.com")
    resp = anon.get(f"/api/public/sign/{token}/pages/0/?w=wide")
    assert resp.status_code == 200, resp.content
    assert abs(_png_width(resp.content) - 900) <= 1


def test_a_page_width_is_clamped_to_a_sane_range(sent, anon):
    token = _token(sent["id"], "signer@example.com")
    huge = anon.get(f"/api/public/sign/{token}/pages/0/?w=99999")
    assert abs(_png_width(huge.content) - 1600) <= 1
    tiny = anon.get(f"/api/public/sign/{token}/pages/0/?w=1")
    assert abs(_png_width(tiny.content) - 200) <= 1


def test_a_page_is_rendered_once_and_then_served_from_storage(sent, anon):
    from apps.pdf_engine.engine import render as engine_render

    token = _token(sent["id"], "signer@example.com")
    with mock.patch.object(engine_render, "render_thumbnail",
                           wraps=engine_render.render_thumbnail) as render:
        first = anon.get(f"/api/public/sign/{token}/pages/0/?w=300")
        second = anon.get(f"/api/public/sign/{token}/pages/0/?w=300")
    assert first.status_code == second.status_code == 200
    assert first.content == second.content
    assert render.call_count == 1


def test_the_disclosure_is_served_verbatim_with_its_version(anon):
    from apps.esign.legal import DISCLOSURE, VERSION, disclosure_hash

    resp = anon.get("/api/public/sign/disclosure/")
    assert resp.status_code == 200
    body = resp.json()
    assert body["version"] == VERSION
    assert body["text"] == DISCLOSURE
    assert body["disclosure_sha256"] == disclosure_hash()


def test_consent_requires_actually_agreeing(sent, anon):
    token = _token(sent["id"], "signer@example.com")
    for payload in ({}, {"agree": False}):
        resp = anon.post(f"/api/public/sign/{token}/consent/", payload,
                         format="json")
        assert resp.status_code == 400
        assert "have to agree" in resp.json()["error"]["message"]
    assert Recipient.objects.get(sign_request_id=sent["id"]).consent_at is None


def test_a_signature_field_needs_an_image(sent, anon):
    token = _token(sent["id"], "signer@example.com")
    meta = anon.get(f"/api/public/sign/{token}/").json()
    anon.post(f"/api/public/sign/{token}/consent/", {"agree": True}, format="json")

    resp = anon.post(f"/api/public/sign/{token}/fields/",
                     {"field_id": meta["fields"][0]["id"]}, format="json")
    assert resp.status_code == 400
    assert "Draw or type your signature first" in resp.json()["error"]["message"]


@pytest.fixture
def typed_fields(api, draft, anon):
    """A consented signer holding a checkbox, a text and a date field."""
    people = _recipients(api, draft["id"], [
        {"email": "signer@example.com", "role": "signer", "order": 1}])
    fields = _fields(api, draft["id"], [
        _field(people[0]["id"], "checkbox", w=0.03, h=0.03, label="Agree"),
        _field(people[0]["id"], "text", y=0.5, label="Full name"),
        _field(people[0]["id"], "date_signed", y=0.6, label="Date"),
    ])
    _send(api, draft["id"])
    token = _token(draft["id"], "signer@example.com")
    anon.get(f"/api/public/sign/{token}/")
    anon.post(f"/api/public/sign/{token}/consent/", {"agree": True}, format="json")
    return token, {f["type"]: f["id"] for f in fields}


@pytest.mark.parametrize("posted, stored", [
    ("on", "true"), (True, "true"), ("1", "true"),
    ("off", "false"), (False, "false"), (None, "false"),
])
def test_a_checkbox_value_is_coerced_to_true_or_false(anon, typed_fields,
                                                     posted, stored):
    token, ids = typed_fields
    resp = anon.post(f"/api/public/sign/{token}/fields/",
                     {"field_id": ids["checkbox"], "value": posted}, format="json")
    assert resp.status_code == 200, resp.content
    # An unticked box is still an *answered* box: the signer looked at it.
    assert resp.json()["filled"] is True
    assert SignField.objects.get(id=ids["checkbox"]).value == stored


def test_a_text_value_is_stored_and_cut_at_five_thousand(anon, typed_fields):
    token, ids = typed_fields
    resp = anon.post(f"/api/public/sign/{token}/fields/",
                     {"field_id": ids["text"], "value": "n" * 6000}, format="json")
    assert resp.status_code == 200, resp.content
    assert len(SignField.objects.get(id=ids["text"]).value) == 5000


def test_the_date_is_not_the_signers_to_fill(anon, typed_fields):
    token, ids = typed_fields
    resp = anon.post(f"/api/public/sign/{token}/fields/",
                     {"field_id": ids["date_signed"], "value": "2020-01-01"},
                     format="json")
    assert resp.status_code == 400
    assert "filled in for you" in resp.json()["error"]["message"]
    assert SignField.objects.get(id=ids["date_signed"]).value == ""


def test_a_signer_cannot_finish_with_a_required_field_empty(sent, anon):
    token = _token(sent["id"], "signer@example.com")
    anon.get(f"/api/public/sign/{token}/")
    anon.post(f"/api/public/sign/{token}/consent/", {"agree": True}, format="json")

    resp = anon.post(f"/api/public/sign/{token}/complete/", format="json")
    assert resp.status_code == 400
    message = resp.json()["error"]["message"]
    assert "required fields are still empty" in message
    assert "signature" in message, "the empty field is not named"
    recipient = Recipient.objects.get(sign_request_id=sent["id"])
    assert recipient.status != Recipient.Status.COMPLETED
    assert SignRequest.objects.get(id=sent["id"]).status == "sent"


def test_a_signer_who_finished_cannot_then_decline(completed, anon):
    token = _token(completed.id, "signer@example.com")
    resp = anon.post(f"/api/public/sign/{token}/decline/", {"reason": "oops"},
                     format="json")
    assert resp.status_code == 400
    assert "already completed" in resp.json()["error"]["message"]
    completed.refresh_from_db()
    assert completed.status == SignRequest.Status.COMPLETED


def test_a_recipient_cannot_download_before_the_envelope_is_finished(sent, anon):
    token = _token(sent["id"], "signer@example.com")
    resp = anon.get(f"/api/public/sign/{token}/download/final/")
    assert resp.status_code == 410
    assert "not finished yet" in resp.json()["error"]["message"]


def test_a_download_link_with_a_bad_token_is_401(anon):
    resp = anon.get("/api/public/sign/not-a-token/download/final/")
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "token_invalid"


# --------------------------------------------------------------------------- #
# /verify
# --------------------------------------------------------------------------- #
def test_verify_without_a_file_names_the_field(anon):
    resp = anon.post("/api/verify/", {}, format="multipart")
    assert resp.status_code == 400
    assert "field 'file'" in resp.json()["error"]["message"]


def test_verify_refuses_a_file_over_its_own_cap(anon, fixture_bytes, settings):
    data = fixture_bytes("text.pdf")
    settings.VERIFY_MAX_UPLOAD_BYTES = len(data) - 1
    with mock.patch("apps.esign.views.SEAL.verify") as verify:
        resp = anon.post("/api/verify/",
                         {"file": SimpleUploadedFile("doc.pdf", data,
                                                     content_type="application/pdf")},
                         format="multipart")
    assert resp.status_code == 400
    assert "too large" in resp.json()["error"]["message"]
    verify.assert_not_called()


@pytest.mark.parametrize("email, masked", [
    ("alice@example.com", "a****@example.com"),
    ("ab@example.com", "a***@example.com"),
    ("no-at-sign", "—"),
    ("", "—"),
])
def test_a_masked_address_keeps_only_its_first_letter(email, masked):
    from apps.esign.views import _mask_email

    assert _mask_email(email) == masked
