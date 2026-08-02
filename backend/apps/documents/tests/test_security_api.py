"""Phase-7 API surface: protect, unlock, permissions, redact, sanitize.

Guest parity throughout (§20 DoD item 9), plus the two properties that only
exist at this layer: an encrypted document stays usable when the session
password travels with the operation, and password material never comes back
out of the API.
"""
import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

pytestmark = pytest.mark.django_db


def _op(client, doc_id, type_, params, base_seq=1):
    resp = client.post(
        f"/api/documents/{doc_id}/operations/",
        {"type": type_, "params": params, "base_version_seq": base_seq},
        format="json",
    )
    assert resp.status_code == 202, resp.content
    return client.get(f"/api/jobs/{resp.json()['id']}/").json()


def _upload(client, name, data):
    upload = SimpleUploadedFile(name, data, content_type="application/pdf")
    resp = client.post("/api/documents/", {"file": upload}, format="multipart")
    assert resp.status_code == 201, resp.content
    return resp.json()


def _content(client, doc_id) -> bytes:
    return b"".join(client.get(f"/api/documents/{doc_id}/content/").streaming_content)


def _drawn(client, doc_id) -> bytes:
    """What the stored document would actually draw.

    A grep of the raw PDF bytes is vacuous — PyMuPDF writes text as hex strings
    inside deflated streams — so `raw_text_bytes` decodes both spellings. See
    `apps/pdf_engine/tests/test_redact.py`.
    """
    from apps.pdf_engine.tests.test_redact import raw_text_bytes

    return raw_text_bytes(_content(client, doc_id))


@pytest.fixture
def pii_doc(api, fixture_bytes):
    return _upload(api, "pii.pdf", fixture_bytes("pii.pdf"))


# --------------------------------------------------------------------------- #
# Protect / unlock
# --------------------------------------------------------------------------- #
def test_protecting_a_document_marks_it_encrypted(api, uploaded_doc):
    job = _op(api, uploaded_doc["id"], "encrypt",
              {"owner_password": "owner-secret", "user_password": "open-me",
               "permissions": {"print": "none", "copy": False}})
    assert job["status"] == "succeeded", job

    detail = api.get(f"/api/documents/{uploaded_doc['id']}/").json()
    assert detail["is_encrypted"] is True
    versions = api.get(f"/api/documents/{uploaded_doc['id']}/versions/").json()["results"]
    assert versions[0]["label"] == "Protected"


def test_unlocking_puts_it_back(api, uploaded_doc):
    _op(api, uploaded_doc["id"], "encrypt",
        {"owner_password": "owner", "user_password": "user"})
    job = _op(api, uploaded_doc["id"], "decrypt", {"password": "user"}, base_seq=2)
    assert job["status"] == "succeeded", job

    detail = api.get(f"/api/documents/{uploaded_doc['id']}/").json()
    assert detail["is_encrypted"] is False
    assert api.get(
        f"/api/documents/{uploaded_doc['id']}/versions/"
    ).json()["results"][0]["label"] == "Unlocked"


def test_a_document_that_arrives_encrypted_unlocks_and_gets_its_pages_back(api, fixture_bytes):
    """`/unlock-pdf`'s whole reason to exist: a file that was already protected
    when it arrived. Ingest cannot count the pages of a locked document, so it
    stores 0 — and unlocking has to put that right, or the workspace opens on a
    document that claims to have nothing in it."""
    doc = _upload(api, "encrypted.pdf", fixture_bytes("encrypted.pdf"))
    assert doc["is_encrypted"] is True
    assert doc["page_count"] == 0

    job = _op(api, doc["id"], "decrypt", {"password": "secret"})
    assert job["status"] == "succeeded", job

    detail = api.get(f"/api/documents/{doc['id']}/").json()
    assert detail["is_encrypted"] is False
    assert detail["page_count"] == 2


def test_the_wrong_password_fails_the_job_with_its_own_code(api, uploaded_doc):
    _op(api, uploaded_doc["id"], "encrypt",
        {"owner_password": "owner", "user_password": "user"})
    job = _op(api, uploaded_doc["id"], "decrypt", {"password": "wrong"}, base_seq=2)
    assert job["status"] == "failed"
    assert job["error_code"] == "invalid_password"


def test_guessing_is_throttled_per_document(api, uploaded_doc):
    """Five wrong passwords a minute and the sixth attempt is refused (§17).

    Per document rather than per session: an attacker with several sessions
    would otherwise get five tries each, which is not a limit.
    """
    from django.core.cache import cache

    cache.clear()
    _op(api, uploaded_doc["id"], "encrypt",
        {"owner_password": "owner", "user_password": "user"})
    for _ in range(5):
        job = _op(api, uploaded_doc["id"], "decrypt", {"password": "no"}, base_seq=2)
        assert job["error_code"] == "invalid_password"

    resp = api.post(f"/api/documents/{uploaded_doc['id']}/operations/",
                    {"type": "decrypt", "params": {"password": "user"},
                     "base_version_seq": 2}, format="json")
    assert resp.status_code == 429
    assert resp.json()["error"]["code"] == "quota_exceeded"
    cache.clear()


def test_an_encrypted_document_refuses_work_without_the_password(api, uploaded_doc):
    _op(api, uploaded_doc["id"], "encrypt",
        {"owner_password": "owner", "user_password": "user"})
    resp = api.post(f"/api/documents/{uploaded_doc['id']}/operations/",
                    {"type": "rotate_pages",
                     "params": {"pages": [0], "degrees": 90},
                     "base_version_seq": 2}, format="json")
    assert resp.status_code == 423  # Locked
    assert resp.json()["error"]["code"] == "document_encrypted"


def test_a_locked_page_answers_423_rather_than_falling_over(api, uploaded_doc):
    """The thumbnail strip asks for one of these per page, and a protected
    document has no pages to draw — so it must be an answer, not a 500."""
    _op(api, uploaded_doc["id"], "encrypt",
        {"owner_password": "owner", "user_password": "user"})
    resp = api.get(f"/api/documents/{uploaded_doc['id']}/pages/0/thumbnail/?w=120")
    assert resp.status_code == 423
    assert resp.json()["error"]["code"] == "document_encrypted"


def test_the_session_password_lets_ordinary_work_continue(api, uploaded_doc):
    """Acceptance criterion: "session-password ops work without re-prompting".

    The client holds the password in memory and sends it with each operation;
    the worker unlocks once, centrally, and no engine module knows about it.
    """
    _op(api, uploaded_doc["id"], "encrypt",
        {"owner_password": "owner", "user_password": "user"})
    resp = api.post(f"/api/documents/{uploaded_doc['id']}/operations/",
                    {"type": "rotate_pages",
                     "params": {"pages": [0], "degrees": 90},
                     "document_password": "user",
                     "base_version_seq": 2}, format="json")
    assert resp.status_code == 202, resp.content
    job = api.get(f"/api/jobs/{resp.json()['id']}/").json()
    assert job["status"] == "succeeded", job

    detail = api.get(f"/api/documents/{uploaded_doc['id']}/").json()
    assert detail["page_count"] == 3


def test_editing_an_unlocked_document_says_the_password_came_off(api, uploaded_doc):
    """The tradeoff, made visible rather than silent.

    An engine works on decrypted bytes and returns a new file; neither password
    is recoverable from the other, so the original encryption cannot be put
    back faithfully. What must never happen is a document quietly ceasing to be
    protected — so the flag flips and the version label says why.
    """
    _op(api, uploaded_doc["id"], "encrypt",
        {"owner_password": "owner", "user_password": "user"})
    resp = api.post(f"/api/documents/{uploaded_doc['id']}/operations/",
                    {"type": "rotate_pages",
                     "params": {"pages": [0], "degrees": 90},
                     "document_password": "user",
                     "base_version_seq": 2}, format="json")
    assert api.get(f"/api/jobs/{resp.json()['id']}/").json()["status"] == "succeeded"

    assert api.get(f"/api/documents/{uploaded_doc['id']}/").json()["is_encrypted"] is False
    label = api.get(f"/api/documents/{uploaded_doc['id']}/versions/").json()["results"][0]["label"]
    assert "password removed" in label, label

    from apps.pdf_engine.engine import security as S

    assert S.is_encrypted(_content(api, uploaded_doc["id"])) is False


@pytest.mark.parametrize("op_type,params", [
    ("watermark", {"text": "DRAFT"}),
    ("page_numbers", {"position": "bottom-center"}),
    ("header_footer", {"segments": {"top-center": "Confidential"}}),
    ("bates", {"prefix": "ZEN-"}),
])
def test_the_session_password_does_not_reach_the_engine(api, uploaded_doc,
                                                        op_type, params):
    """The four ops that splat `params` straight into their engine function.

    The password is a credential for the *document*, not a parameter of the
    operation — leaving it in `params` turned "watermark a document I have
    unlocked" into `TypeError: unexpected keyword argument`.
    """
    _op(api, uploaded_doc["id"], "encrypt",
        {"owner_password": "owner", "user_password": "user"})
    resp = api.post(f"/api/documents/{uploaded_doc['id']}/operations/",
                    {"type": op_type, "params": params,
                     "document_password": "user", "base_version_seq": 2},
                    format="json")
    assert resp.status_code == 202, resp.content
    job = api.get(f"/api/jobs/{resp.json()['id']}/").json()
    assert job["status"] == "succeeded", job


def test_reverting_to_a_protected_version_makes_it_protected_again(api, uploaded_doc):
    """Phase 7 is the first phase where a *version* can be encrypted and the
    document not. Leaving the flag alone left the viewer showing no padlock, no
    prompt, and a document whose every page answered 423."""
    _op(api, uploaded_doc["id"], "encrypt",
        {"owner_password": "owner", "user_password": "user"})
    _op(api, uploaded_doc["id"], "decrypt", {"password": "user"}, base_seq=2)
    assert api.get(f"/api/documents/{uploaded_doc['id']}/").json()["is_encrypted"] is False

    resp = api.post(f"/api/documents/{uploaded_doc['id']}/versions/2/revert/", format="json")
    assert resp.status_code == 202, resp.content
    assert api.get(f"/api/jobs/{resp.json()['id']}/").json()["status"] == "succeeded"
    assert api.get(f"/api/documents/{uploaded_doc['id']}/").json()["is_encrypted"] is True

    # …and back again, which is the same bug in the other direction.
    resp = api.post(f"/api/documents/{uploaded_doc['id']}/versions/3/revert/", format="json")
    assert api.get(f"/api/jobs/{resp.json()['id']}/").json()["status"] == "succeeded"
    assert api.get(f"/api/documents/{uploaded_doc['id']}/").json()["is_encrypted"] is False


def test_permissions_can_be_changed(api, uploaded_doc):
    _op(api, uploaded_doc["id"], "encrypt",
        {"owner_password": "owner", "permissions": {"print": "none"}})
    job = _op(api, uploaded_doc["id"], "set_permissions",
              {"owner_password": "owner",
               "permissions": {"print": "full", "copy": True}},
              base_seq=2)
    assert job["status"] == "succeeded", job

    from apps.pdf_engine.engine import security as S

    assert S.read_permissions(_content(api, uploaded_doc["id"]))["print"] == "full"


def test_a_guest_protects_and_unlocks(guest, guest_doc):
    job = _op(guest, guest_doc["id"], "encrypt",
              {"owner_password": "owner", "user_password": "user"})
    assert job["status"] == "succeeded", job
    job = _op(guest, guest_doc["id"], "decrypt", {"password": "user"}, base_seq=2)
    assert job["status"] == "succeeded", job


# --------------------------------------------------------------------------- #
# Passwords never come back out
# --------------------------------------------------------------------------- #
def test_the_api_never_echoes_a_password(api, uploaded_doc):
    """The job detail endpoint is polled by the client that just sent it, so an
    echoed password lands in every proxy log on the way back."""
    resp = api.post(f"/api/documents/{uploaded_doc['id']}/operations/",
                    {"type": "encrypt",
                     "params": {"owner_password": "hunter2",
                                "user_password": "correct-horse"},
                     "base_version_seq": 1}, format="json")
    assert resp.status_code == 202
    body = resp.json()
    assert "hunter2" not in str(body)
    assert body["params"]["owner_password"] == "••••••"

    detail = api.get(f"/api/jobs/{body['id']}/").json()
    assert "hunter2" not in str(detail)
    assert "correct-horse" not in str(detail)

    listing = api.get("/api/jobs/").json()
    assert "hunter2" not in str(listing)


def test_the_password_is_dropped_from_the_row_when_the_job_finishes(api, uploaded_doc):
    from apps.jobs.models import Job

    resp = api.post(f"/api/documents/{uploaded_doc['id']}/operations/",
                    {"type": "encrypt", "params": {"owner_password": "hunter2"},
                     "base_version_seq": 1}, format="json")
    job = Job.objects.get(id=resp.json()["id"])
    assert job.status == "succeeded"
    assert "owner_password" not in job.params, job.params


def test_a_failed_job_forgets_the_password_too(api, uploaded_doc):
    from apps.jobs.models import Job

    _op(api, uploaded_doc["id"], "encrypt", {"owner_password": "owner",
                                             "user_password": "user"})
    resp = api.post(f"/api/documents/{uploaded_doc['id']}/operations/",
                    {"type": "decrypt", "params": {"password": "wrong"},
                     "base_version_seq": 2}, format="json")
    job = Job.objects.get(id=resp.json()["id"])
    assert job.status == "failed"
    assert "password" not in job.params, job.params


# --------------------------------------------------------------------------- #
# Redaction
# --------------------------------------------------------------------------- #
def test_the_dry_run_returns_a_review_list_and_mints_no_version(api, pii_doc):
    before = api.get(f"/api/documents/{pii_doc['id']}/versions/").json()["results"]
    job = _op(api, pii_doc["id"], "redact",
              {"patterns": [{"kind": "preset", "value": "email"}], "dry_run": True})
    assert job["status"] == "succeeded", job
    report = job["result"]["report"]
    assert report["count"] == 3
    assert all("rect" in m and "text" in m for m in report["matches"])

    after = api.get(f"/api/documents/{pii_doc['id']}/versions/").json()["results"]
    assert len(after) == len(before), "a search must not mint a version"


def test_redacting_in_place_creates_a_redacted_version(api, pii_doc):
    job = _op(api, pii_doc["id"], "redact",
              {"patterns": [{"kind": "preset", "value": "email"}]})
    assert job["status"] == "succeeded", job
    assert api.get(
        f"/api/documents/{pii_doc['id']}/versions/"
    ).json()["results"][0]["label"] == "Redacted"
    assert b"dana.cohen" not in _drawn(api, pii_doc["id"])


def test_the_clean_copy_has_no_history_to_leak(api, pii_doc):
    """Acceptance criterion. A redacted document whose *previous version* still
    holds the content is not redacted — and the version history is one click
    away in the workspace."""
    job = _op(api, pii_doc["id"], "redact",
              {"patterns": [{"kind": "preset", "value": "email"}],
               "fork_clean_copy": True})
    assert job["status"] == "succeeded", job

    new_id = job["result"]["documents"][0]
    versions = api.get(f"/api/documents/{new_id}/versions/").json()["results"]
    assert len(versions) == 1, "the clean copy carries history"
    assert versions[0]["label"] == "Original"
    assert b"dana.cohen" not in _drawn(api, new_id)
    assert api.get(f"/api/documents/{new_id}/").json()["title"].endswith("(redacted)")

    # …and the original is untouched, which is what makes it a *copy*.
    assert b"dana.cohen" in _drawn(api, pii_doc["id"])


def test_the_clean_copy_still_reports_its_verification(api, pii_doc):
    """The verification pass is the phase's answer to text-as-outlines, and the
    clean copy is the *default* path — dropping the report there made the
    warning unreachable exactly where it matters."""
    job = _op(api, pii_doc["id"], "redact",
              {"patterns": [{"kind": "preset", "value": "email"}],
               "fork_clean_copy": True})
    assert job["result"]["report"]["verification"] == {
        "rechecked": True, "residual_matches": 0,
    }


def test_a_copy_taken_from_an_unlocked_document_says_it_is_not_protected(
        api, uploaded_doc):
    _op(api, uploaded_doc["id"], "encrypt",
        {"owner_password": "owner", "user_password": "user"})
    resp = api.post(f"/api/documents/{uploaded_doc['id']}/operations/",
                    {"type": "extract_pages",
                     "params": {"pages": [0], "as_new_document": True},
                     "document_password": "user", "base_version_seq": 2},
                    format="json")
    job = api.get(f"/api/jobs/{resp.json()['id']}/").json()
    assert job["status"] == "succeeded", job

    new_id = job["result"]["documents"][0]
    versions = api.get(f"/api/documents/{new_id}/versions/").json()["results"]
    assert "password removed" in versions[0]["label"], versions[0]


def test_only_the_kept_matches_are_applied(api, pii_doc):
    found = _op(api, pii_doc["id"], "redact",
                {"patterns": [{"kind": "preset", "value": "email"}],
                 "dry_run": True})["result"]["report"]
    keep = [found["matches"][1]["id"]]

    job = _op(api, pii_doc["id"], "redact",
              {"patterns": [{"kind": "preset", "value": "email"}], "only": keep})
    assert job["result"]["report"]["applied"] == 1
    drawn = _drawn(api, pii_doc["id"])
    assert b"dana.cohen" in drawn
    assert b"r.levi" not in drawn


def test_a_guest_redacts(guest, fixture_bytes):
    doc = _upload(guest, "pii.pdf", fixture_bytes("pii.pdf"))
    job = _op(guest, doc["id"], "redact",
              {"patterns": [{"kind": "preset", "value": "ssn"}]})
    assert job["status"] == "succeeded", job
    assert b"123-45-6789" not in _drawn(guest, doc["id"])


def test_redaction_params_are_validated_before_a_job_exists(api, pii_doc):
    from apps.jobs.models import Job

    resp = api.post(f"/api/documents/{pii_doc['id']}/operations/",
                    {"type": "redact",
                     "params": {"patterns": [{"kind": "sorcery", "value": "x"}]}},
                    format="json")
    assert resp.status_code == 400
    assert Job.objects.count() == 0


# --------------------------------------------------------------------------- #
# Sanitize
# --------------------------------------------------------------------------- #
def test_sanitize_reports_what_it_removed(api, fixture_bytes):
    doc = _upload(api, "trap.pdf", fixture_bytes("booby-trapped.pdf"))
    job = _op(api, doc["id"], "sanitize",
              {"javascript": True, "embedded_files": True, "metadata": True})
    assert job["status"] == "succeeded", job

    report = job["result"]["report"]
    assert report["javascript"] >= 2
    assert report["embedded_files"] >= 1
    assert report["total"] >= 3
    label = api.get(f"/api/documents/{doc['id']}/versions/").json()["results"][0]["label"]
    assert label.startswith("Sanitized")

    content = _content(api, doc["id"])
    assert b"app.alert" not in content
    assert b"attached secret" not in content


def test_a_guest_sanitizes(guest, fixture_bytes):
    doc = _upload(guest, "trap.pdf", fixture_bytes("booby-trapped.pdf"))
    job = _op(guest, doc["id"], "sanitize", {"javascript": True})
    assert job["status"] == "succeeded", job


def test_sanitize_needs_a_choice(api, uploaded_doc):
    job = _op(api, uploaded_doc["id"], "sanitize", {})
    assert job["status"] == "failed"
    assert "at least one" in job["error_message"]
