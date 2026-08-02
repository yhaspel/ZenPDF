"""The signing loop through the API (phase-08 §Tests).

Builder → send → ceremony → finalize → certificate → verify, plus the things
that must *not* work: signing before it is your turn, filling somebody else's
field, skipping consent, reusing a token after completing, and a guest trying
to send a request at all (the Phase-2B gate).
"""
import base64

import pytest
from django.core import mail
from django.utils import timezone

from apps.esign.models import Recipient, SignField, SignRequest

pytestmark = pytest.mark.django_db


def _draw_png() -> str:
    """A real drawn signature: ink on transparency, as the canvas sends it."""
    import fitz

    doc = fitz.open()
    page = doc.new_page(width=300, height=120)
    page.draw_line((40, 80), (260, 50), width=3)
    data = page.get_pixmap(alpha=True).tobytes("png")
    doc.close()
    return "data:image/png;base64," + base64.b64encode(data).decode()


@pytest.fixture
def sign_request(api, uploaded_doc):
    resp = api.post("/api/sign-requests/",
                    {"document": uploaded_doc["id"], "title": "Employment offer",
                     "message": "Please sign by Friday."}, format="json")
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


def _token(request_id, email) -> str:
    return Recipient.objects.get(sign_request_id=request_id, email=email).token


def _sign_field(recipient_id, page=0, type_="signature"):
    return {"recipient_id": recipient_id, "page": page, "x": 0.1, "y": 0.7,
            "w": 0.3, "h": 0.08, "type": type_, "required": True,
            "label": "Sign here"}


# --------------------------------------------------------------------------- #
# The builder
# --------------------------------------------------------------------------- #
def test_a_draft_is_created_and_edited(api, sign_request):
    assert sign_request["status"] == "draft"
    assert sign_request["envelope_code"].startswith("ZEN-")

    people = _recipients(api, sign_request["id"], [
        {"email": "signer@example.com", "name": "Sam", "role": "signer", "order": 1},
        {"email": "watcher@example.com", "role": "cc", "order": 1},
    ])
    assert [p["role"] for p in people] == ["signer", "cc"]

    fields = _fields(api, sign_request["id"], [_sign_field(people[0]["id"])])
    assert len(fields) == 1 and fields[0]["type"] == "signature"


def test_a_field_cannot_be_bound_to_a_stranger(api, sign_request, other_user):
    people = _recipients(api, sign_request["id"], [
        {"email": "signer@example.com", "role": "signer", "order": 1}])
    resp = api.patch(f"/api/sign-requests/{sign_request['id']}/",
                     {"fields": [_sign_field(str(other_user.id))]}, format="json")
    assert resp.status_code == 400
    assert "recipient" in resp.json()["error"]["message"].lower()
    assert people  # the recipient list is untouched


def test_sending_needs_a_signer_with_something_to_sign(api, sign_request):
    resp = api.post(f"/api/sign-requests/{sign_request['id']}/send/", format="json")
    assert resp.status_code == 400
    assert "signer" in resp.json()["error"]["message"]

    people = _recipients(api, sign_request["id"], [
        {"email": "signer@example.com", "role": "signer", "order": 1}])
    resp = api.post(f"/api/sign-requests/{sign_request['id']}/send/", format="json")
    assert resp.status_code == 400
    assert "nothing to sign" in resp.json()["error"]["message"]

    _fields(api, sign_request["id"], [_sign_field(people[0]["id"])])
    assert api.post(f"/api/sign-requests/{sign_request['id']}/send/",
                    format="json").status_code == 200


def test_a_sent_request_cannot_be_edited(api, sign_request):
    people = _recipients(api, sign_request["id"], [
        {"email": "signer@example.com", "role": "signer", "order": 1}])
    _fields(api, sign_request["id"], [_sign_field(people[0]["id"])])
    api.post(f"/api/sign-requests/{sign_request['id']}/send/", format="json")

    resp = api.patch(f"/api/sign-requests/{sign_request['id']}/",
                     {"title": "Something else"}, format="json")
    assert resp.status_code == 400
    assert "already been sent" in resp.json()["error"]["message"]


# --------------------------------------------------------------------------- #
# The full loop
# --------------------------------------------------------------------------- #
@pytest.fixture
def sent(api, sign_request):
    """Two signers in sequence plus a cc — the phase's own e2e shape."""
    people = _recipients(api, sign_request["id"], [
        {"email": "first@example.com", "name": "First", "role": "signer", "order": 1},
        {"email": "second@example.com", "name": "Second", "role": "signer", "order": 2},
        {"email": "watcher@example.com", "name": "Watcher", "role": "cc", "order": 2},
    ])
    _fields(api, sign_request["id"], [
        _sign_field(people[0]["id"]),
        {**_sign_field(people[1]["id"]), "y": 0.8},
        {"recipient_id": people[1]["id"], "page": 0, "x": 0.5, "y": 0.8,
         "w": 0.2, "h": 0.03, "type": "date_signed", "required": True,
         "label": "Date"},
    ])
    mail.outbox.clear()
    resp = api.post(f"/api/sign-requests/{sign_request['id']}/send/", format="json")
    assert resp.status_code == 200, resp.content
    return resp.json()


def _ceremony(anon, token):
    resp = anon.get(f"/api/public/sign/{token}/")
    assert resp.status_code == 200, resp.content
    return resp.json()


def _consent(anon, token):
    return anon.post(f"/api/public/sign/{token}/consent/", {"agree": True},
                     format="json")


def _fill_signature(anon, token, field_id):
    return anon.post(f"/api/public/sign/{token}/fields/",
                     {"field_id": field_id, "signature_image": _draw_png()},
                     format="json")


def test_only_the_first_signer_is_emailed(sent, anon):
    assert len(mail.outbox) == 1
    assert mail.outbox[0].to == ["first@example.com"]
    assert "/s/" in mail.outbox[0].body

    second = _token(sent["id"], "second@example.com")
    meta = _ceremony(anon, second)
    assert meta["me"]["my_turn"] is False, "signer 2 could act before signer 1"


def test_nothing_can_be_filled_before_consent(sent, anon):
    token = _token(sent["id"], "first@example.com")
    meta = _ceremony(anon, token)
    field_id = meta["fields"][0]["id"]

    resp = _fill_signature(anon, token, field_id)
    assert resp.status_code == 400
    assert "Agree to sign electronically" in resp.json()["error"]["message"]

    assert _consent(anon, token).status_code == 200
    assert _fill_signature(anon, token, field_id).status_code == 200


def test_consent_records_the_exact_disclosure_it_agreed_to(sent, anon):
    from apps.esign.legal import disclosure_hash

    token = _token(sent["id"], "first@example.com")
    _ceremony(anon, token)
    body = _consent(anon, token).json()
    assert body["disclosure_sha256"] == disclosure_hash()

    event = SignRequest.objects.get(id=sent["id"]).audit_events.filter(
        type="consented").first()
    assert event.metadata["disclosure_sha256"] == disclosure_hash()
    assert event.ip and event.user_agent is not None


def test_one_signer_cannot_fill_anothers_field(sent, anon):
    first = _token(sent["id"], "first@example.com")
    _ceremony(anon, first)
    _consent(anon, first)

    others = SignField.objects.filter(
        sign_request_id=sent["id"],
        recipient__email="second@example.com").exclude(type="date_signed")
    resp = anon.post(f"/api/public/sign/{first}/fields/",
                     {"field_id": str(others.first().id),
                      "signature_image": _draw_png()}, format="json")
    assert resp.status_code == 400
    assert "not yours" in resp.json()["error"]["message"]


def test_the_full_two_signer_loop_completes_and_seals(sent, anon, api):
    request_id = sent["id"]

    # --- signer 1 ---
    first = _token(request_id, "first@example.com")
    meta = _ceremony(anon, first)
    assert meta["me"]["role"] == "signer" and meta["me"]["my_turn"] is True
    _consent(anon, first)
    _fill_signature(anon, first, meta["fields"][0]["id"])
    mail.outbox.clear()
    resp = anon.post(f"/api/public/sign/{first}/complete/", format="json")
    assert resp.status_code == 200, resp.content
    assert resp.json()["next"] == "notified"

    # …which is what emails signer 2, and only then.
    assert [m.to for m in mail.outbox] == [["second@example.com"]]

    # --- signer 2 ---
    second = _token(request_id, "second@example.com")
    meta = _ceremony(anon, second)
    assert meta["me"]["my_turn"] is True
    _consent(anon, second)
    signature = [f for f in meta["fields"] if f["type"] == "signature"][0]
    _fill_signature(anon, second, signature["id"])
    mail.outbox.clear()
    resp = anon.post(f"/api/public/sign/{second}/complete/", format="json")
    assert resp.status_code == 200, resp.content

    # --- finalized ---
    sign_request = SignRequest.objects.get(id=request_id)
    assert sign_request.status == SignRequest.Status.COMPLETED
    assert sign_request.final_sha256 and sign_request.final_key
    assert sign_request.certificate_key

    # Everyone hears about it, including the cc.
    recipients = {addr for m in mail.outbox for addr in m.to}
    assert {"first@example.com", "second@example.com", "watcher@example.com"} \
        <= recipients

    # The sealed file is what the fingerprint describes.
    import hashlib

    from apps.pdf_engine.storage import get_storage

    final = get_storage().get_bytes(sign_request.final_key)
    assert hashlib.sha256(final).hexdigest() == sign_request.final_sha256

    from apps.pdf_engine.engine import seal as SEAL

    report = SEAL.verify(final)
    assert report["sealed"] is True
    assert report["integrity"] == "intact"
    assert report["signatures"][0]["whole_document"] is True
    assert sign_request.envelope_code in SEAL.find_envelope_code(final)

    # …and any byte modification flips it (acceptance criterion 3).
    tampered = bytearray(final)
    index = final.index(b"/Type/Page")
    tampered[index + 300] = (tampered[index + 300] + 1) % 256
    assert SEAL.verify(bytes(tampered))["integrity"] == "modified"

    # The signed file also lands on the source document, for the owner.
    versions = api.get(
        f"/api/documents/{sign_request.document_id}/versions/").json()
    assert versions[0]["label"] == "Signed"


def test_a_completed_token_cannot_be_reused(sent, anon):
    token = _token(sent["id"], "first@example.com")
    meta = _ceremony(anon, token)
    _consent(anon, token)
    _fill_signature(anon, token, meta["fields"][0]["id"])
    anon.post(f"/api/public/sign/{token}/complete/", format="json")

    resp = anon.post(f"/api/public/sign/{token}/complete/", format="json")
    assert resp.status_code == 410
    assert "already completed" in resp.json()["error"]["message"]


def test_an_invalid_token_is_401_and_says_nothing_else(sent, anon):
    resp = anon.get("/api/public/sign/not-a-real-token/")
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "token_invalid"


def test_an_expired_request_stops_accepting(sent, anon):
    SignRequest.objects.filter(id=sent["id"]).update(
        expires_at=timezone.now() - timezone.timedelta(days=1))
    token = _token(sent["id"], "first@example.com")
    resp = anon.get(f"/api/public/sign/{token}/")
    assert resp.status_code == 410
    assert resp.json()["error"]["code"] == "token_expired"


def test_declining_stops_everything_and_tells_the_people_who_signed(sent, anon):
    first = _token(sent["id"], "first@example.com")
    meta = _ceremony(anon, first)
    _consent(anon, first)
    _fill_signature(anon, first, meta["fields"][0]["id"])
    anon.post(f"/api/public/sign/{first}/complete/", format="json")

    second = _token(sent["id"], "second@example.com")
    _ceremony(anon, second)
    mail.outbox.clear()
    resp = anon.post(f"/api/public/sign/{second}/decline/",
                     {"reason": "The dates are wrong"}, format="json")
    assert resp.status_code == 200

    sign_request = SignRequest.objects.get(id=sent["id"])
    assert sign_request.status == SignRequest.Status.DECLINED
    told = {addr for m in mail.outbox for addr in m.to}
    assert "first@example.com" in told, "the person who already signed was not told"
    assert sign_request.owner.email in told

    # And the link stops working for everybody.
    assert anon.get(f"/api/public/sign/{first}/").status_code == 410


def test_the_frozen_version_is_what_gets_signed(sent, anon, api, fixture_bytes):
    """Editing the document after sending must not change what is being signed."""
    sign_request = SignRequest.objects.get(id=sent["id"])
    before = sign_request.source_version.seq

    resp = api.post(f"/api/documents/{sign_request.document_id}/operations/",
                    {"type": "rotate_pages",
                     "params": {"pages": [0], "degrees": 90},
                     "base_version_seq": before}, format="json")
    assert resp.status_code == 202

    sign_request.refresh_from_db()
    assert sign_request.source_version.seq == before, "the request followed the edit"

    token = _token(sent["id"], "first@example.com")
    content = anon.get(f"/api/public/sign/{token}/content/")
    assert content.status_code == 200

    import fitz

    doc = fitz.open(stream=content.content, filetype="pdf")
    try:
        assert doc[0].rotation == 0, "the ceremony served the edited document"
    finally:
        doc.close()


def test_the_certificate_reproduces_every_event(sent, anon):
    request_id = sent["id"]
    for email in ("first@example.com", "second@example.com"):
        token = _token(request_id, email)
        meta = _ceremony(anon, token)
        _consent(anon, token)
        for field in meta["fields"]:
            if field["type"] == "signature":
                _fill_signature(anon, token, field["id"])
        anon.post(f"/api/public/sign/{token}/complete/", format="json")

    sign_request = SignRequest.objects.get(id=request_id)
    from apps.pdf_engine.storage import get_storage

    cert = get_storage().get_bytes(sign_request.certificate_key)

    import fitz

    doc = fitz.open(stream=cert, filetype="pdf")
    try:
        text = "\n".join(page.get_text() for page in doc)
    finally:
        doc.close()

    assert sign_request.envelope_code in text
    assert sign_request.final_sha256 in text.replace("\n", "")
    assert "first@example.com" in text and "second@example.com" in text
    for event_type in ("Sent", "Opened", "Consented", "Signed", "Completed"):
        assert event_type in text, f"{event_type} missing from the certificate"
    assert "The chain verifies." in text


def test_finalizing_twice_seals_once(sent, anon):
    from apps.esign.tasks import finalize_sign_request

    request_id = sent["id"]
    for email in ("first@example.com", "second@example.com"):
        token = _token(request_id, email)
        meta = _ceremony(anon, token)
        _consent(anon, token)
        for field in meta["fields"]:
            if field["type"] == "signature":
                _fill_signature(anon, token, field["id"])
        anon.post(f"/api/public/sign/{token}/complete/", format="json")

    sign_request = SignRequest.objects.get(id=request_id)
    first_sha = sign_request.final_sha256

    # Two recipients finishing in the same second both dispatch this.
    result = finalize_sign_request(str(request_id))
    assert result == {"already": True, "envelope": sign_request.envelope_code}

    sign_request.refresh_from_db()
    assert sign_request.final_sha256 == first_sha
    assert sign_request.audit_events.filter(type="seal_applied").count() == 1


def test_a_recipient_downloads_their_own_copy(sent, anon):
    request_id = sent["id"]
    for email in ("first@example.com", "second@example.com"):
        token = _token(request_id, email)
        meta = _ceremony(anon, token)
        _consent(anon, token)
        for field in meta["fields"]:
            if field["type"] == "signature":
                _fill_signature(anon, token, field["id"])
        anon.post(f"/api/public/sign/{token}/complete/", format="json")

    watcher = _token(request_id, "watcher@example.com")
    final = anon.get(f"/api/public/sign/{watcher}/download/final/")
    assert final.status_code == 200
    assert final["Content-Type"] == "application/pdf"
    cert = anon.get(f"/api/public/sign/{watcher}/download/certificate/")
    assert cert.status_code == 200

    # …and every download is in the record.
    assert SignRequest.objects.get(id=request_id).audit_events.filter(
        type="downloaded").count() == 2


# --------------------------------------------------------------------------- #
# Access (§21.3) — the Phase-2B gate
# --------------------------------------------------------------------------- #
def test_a_guest_cannot_send_a_signature_request(guest, guest_doc):
    """Phase-2B acceptance criterion, carried here: 403 `account_required`,
    with copy the UI turns into a signup prompt — never a login wall."""
    resp = guest.post("/api/sign-requests/",
                      {"document": guest_doc["id"], "title": "Nope"},
                      format="json")
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "account_required"
    assert "free account" in resp.json()["error"]["message"]
    assert SignRequest.objects.count() == 0


def test_a_guest_cannot_keep_a_saved_signature(guest):
    resp = guest.get("/api/signatures/")
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "account_required"


def test_a_guest_can_render_a_typed_signature(guest):
    """The other half of the split: previewing a typed signature stores
    nothing, so it needs no account — it is how a guest signs."""
    resp = guest.post("/api/signatures/render/",
                      {"text": "Ada Lovelace", "font": "caveat"}, format="json")
    assert resp.status_code == 200
    assert resp["Content-Type"] == "image/png"
    assert resp.content[:8] == b"\x89PNG\r\n\x1a\n"


def test_another_account_cannot_see_a_request(api, other_api, sign_request):
    assert other_api.get(f"/api/sign-requests/{sign_request['id']}/").status_code == 404
    assert other_api.get(f"/api/sign-requests/{sign_request['id']}/audit/"
                         ).status_code == 404


def test_the_owner_view_never_leaks_a_token(api, sent):
    body = api.get(f"/api/sign-requests/{sent['id']}/").json()
    tokens = {r.token for r in Recipient.objects.filter(sign_request_id=sent["id"])}
    serialized = str(body)
    assert not any(token in serialized for token in tokens)


def test_the_monthly_quota_is_enforced(api, uploaded_doc, settings):
    """Acceptance criterion 7 (§16)."""
    tiers = {**settings.TIERS}
    tiers["free"] = {**tiers["free"], "sign_requests_per_month": 1}
    settings.TIERS = tiers

    first = api.post("/api/sign-requests/", {"document": uploaded_doc["id"]},
                     format="json")
    assert first.status_code == 201
    people = _recipients(api, first.json()["id"], [
        {"email": "s@example.com", "role": "signer", "order": 1}])
    _fields(api, first.json()["id"], [_sign_field(people[0]["id"])])
    assert api.post(f"/api/sign-requests/{first.json()['id']}/send/",
                    format="json").status_code == 200

    resp = api.post("/api/sign-requests/", {"document": uploaded_doc["id"]},
                    format="json")
    assert resp.status_code == 429
    assert resp.json()["error"]["code"] == "quota_exceeded"


# --------------------------------------------------------------------------- #
# Reminders and expiry (beat)
# --------------------------------------------------------------------------- #
def test_reminders_respect_the_cadence(sent, anon):
    from apps.esign.tasks import sign_reminders

    token = _token(sent["id"], "first@example.com")
    _ceremony(anon, token)  # notified → viewed

    mail.outbox.clear()
    assert sign_reminders() == {"reminders": 0}, "nudged on the same day"

    Recipient.objects.filter(sign_request_id=sent["id"],
                             email="first@example.com").update(
        last_notified_at=timezone.now() - timezone.timedelta(days=4))
    assert sign_reminders() == {"reminders": 1}
    assert mail.outbox[0].to == ["first@example.com"]
    assert SignRequest.objects.get(id=sent["id"]).audit_events.filter(
        type="reminder_sent").count() == 1


def test_expiry_closes_the_request_and_tells_everyone(sent):
    from apps.esign.tasks import sign_expirations

    SignRequest.objects.filter(id=sent["id"]).update(
        expires_at=timezone.now() - timezone.timedelta(minutes=1))
    mail.outbox.clear()

    assert sign_expirations() == {"expired": 1}
    sign_request = SignRequest.objects.get(id=sent["id"])
    assert sign_request.status == SignRequest.Status.EXPIRED
    told = {addr for m in mail.outbox for addr in m.to}
    assert sign_request.owner.email in told
    assert "first@example.com" in told


def test_a_manual_nudge_is_limited_to_one_a_day(api, sent):
    mail.outbox.clear()
    first = api.post(f"/api/sign-requests/{sent['id']}/remind/", format="json")
    assert first.status_code == 200
    assert first.json()["reminded"] == []  # just emailed by send/

    Recipient.objects.filter(sign_request_id=sent["id"],
                             email="first@example.com").update(
        last_notified_at=timezone.now() - timezone.timedelta(days=2))
    second = api.post(f"/api/sign-requests/{sent['id']}/remind/", format="json")
    assert second.json()["reminded"] == ["first@example.com"]

    third = api.post(f"/api/sign-requests/{sent['id']}/remind/", format="json")
    assert third.json()["reminded"] == []


# --------------------------------------------------------------------------- #
# /verify
# --------------------------------------------------------------------------- #
def _upload(client, data: bytes, name="doc.pdf"):
    from django.core.files.uploadedfile import SimpleUploadedFile

    return client.post("/api/verify/",
                       {"file": SimpleUploadedFile(name, data,
                                                   content_type="application/pdf")},
                       format="multipart")


def test_verify_reports_an_unsigned_file_honestly(anon, fixture_bytes):
    body = _upload(anon, fixture_bytes("text.pdf")).json()
    assert body["sealed"] is False
    assert body["integrity"] == "unsigned"
    assert body["envelope_match"]["found_code"] is None


def test_verify_recognises_our_own_completed_envelope(sent, anon):
    request_id = sent["id"]
    for email in ("first@example.com", "second@example.com"):
        token = _token(request_id, email)
        meta = _ceremony(anon, token)
        _consent(anon, token)
        for field in meta["fields"]:
            if field["type"] == "signature":
                _fill_signature(anon, token, field["id"])
        anon.post(f"/api/public/sign/{token}/complete/", format="json")

    sign_request = SignRequest.objects.get(id=request_id)
    from apps.pdf_engine.storage import get_storage

    final = get_storage().get_bytes(sign_request.final_key)

    body = _upload(anon, final).json()
    assert body["sealed"] is True
    assert body["integrity"] == "intact"
    assert body["envelope_match"] == {
        "found_code": sign_request.envelope_code,
        "known": True,
        "sha256_match": True,
        "completed_at": body["envelope_match"]["completed_at"],
        "signers": body["envelope_match"]["signers"],
    }
    # Addresses are masked: the file may be in anybody's hands by then.
    assert all("*" in s["email"] for s in body["envelope_match"]["signers"])
    # Honest about a self-signed dev certificate.
    assert body["signatures"][0]["trusted"] is False


def test_verify_flags_a_modified_file(sent, anon):
    request_id = sent["id"]
    for email in ("first@example.com", "second@example.com"):
        token = _token(request_id, email)
        meta = _ceremony(anon, token)
        _consent(anon, token)
        for field in meta["fields"]:
            if field["type"] == "signature":
                _fill_signature(anon, token, field["id"])
        anon.post(f"/api/public/sign/{token}/complete/", format="json")

    from apps.pdf_engine.storage import get_storage

    sign_request = SignRequest.objects.get(id=request_id)
    final = bytearray(get_storage().get_bytes(sign_request.final_key))
    index = bytes(final).index(b"/Type/Page")
    final[index + 300] = (final[index + 300] + 1) % 256

    body = _upload(anon, bytes(final)).json()
    assert body["integrity"] == "modified"
    assert body["envelope_match"]["known"] is True
    assert body["envelope_match"]["sha256_match"] is False


def test_verify_refuses_something_that_is_not_a_pdf(anon):
    body = _upload(anon, b"this is not a pdf", name="notes.txt")
    assert body.status_code == 400
    assert body.json()["error"]["code"] == "validation_error"


def test_verify_needs_no_account_and_no_guest_session(anon, fixture_bytes):
    resp = _upload(anon, fixture_bytes("text.pdf"))
    assert resp.status_code == 200
    assert "X-Guest-Token" not in resp, "verification minted a session"
