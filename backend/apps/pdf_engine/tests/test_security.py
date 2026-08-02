"""Golden tests for encryption, permissions and sanitize (phase-07; §17, §18)."""
import io

import fitz
import pikepdf
import pytest

from apps.pdf_engine.engine import security as S
from apps.pdf_engine.exceptions import EngineError, InvalidParams


def _open(data: bytes, password: str = ""):
    return pikepdf.open(io.BytesIO(data), password=password)


# --------------------------------------------------------------------------- #
# Encryption
# --------------------------------------------------------------------------- #
def test_encrypting_makes_the_document_need_a_password(fixture_bytes):
    out = S.encrypt(fixture_bytes("text.pdf"), owner_password="owner-secret",
                    user_password="open-sesame")
    assert S.is_encrypted(out)

    with pytest.raises(pikepdf.PasswordError):
        _open(out)
    pdf = _open(out, "open-sesame")
    try:
        assert len(pdf.pages) == 3
        assert pdf.is_encrypted
    finally:
        pdf.close()


def test_an_owner_password_alone_leaves_the_document_openable(fixture_bytes):
    """Restrictions without an open password: anyone can read it, and a
    conforming reader honours the limits. That is a real and common choice."""
    out = S.encrypt(fixture_bytes("text.pdf"), owner_password="owner-secret",
                    permissions={"print": "none", "copy": False})
    pdf = _open(out)
    try:
        assert pdf.is_encrypted
        assert not pdf.allow.print_highres
        assert not pdf.allow.extract
    finally:
        pdf.close()


def test_an_owner_password_is_required(fixture_bytes):
    """A permission set nobody can lift is a document its author cannot get
    back."""
    with pytest.raises(InvalidParams, match="owner password"):
        S.encrypt(fixture_bytes("text.pdf"), owner_password="")


@pytest.mark.parametrize("level,highres,lowres", [
    ("none", False, False),
    ("lowres", False, True),
    ("full", True, True),
])
def test_print_permission_levels_land_on_the_right_bits(fixture_bytes, level,
                                                        highres, lowres):
    out = S.encrypt(fixture_bytes("text.pdf"), owner_password="o",
                    permissions={"print": level})
    pdf = _open(out)
    try:
        assert pdf.allow.print_highres is highres
        assert pdf.allow.print_lowres is lowres
    finally:
        pdf.close()


@pytest.mark.parametrize("level,form,annot,other", [
    ("none", False, False, False),
    ("form_fill", True, False, False),
    ("annotate", True, True, False),
    ("full", True, True, True),
])
def test_modify_permission_levels_land_on_the_right_bits(fixture_bytes, level,
                                                         form, annot, other):
    out = S.encrypt(fixture_bytes("text.pdf"), owner_password="o",
                    permissions={"modify": level})
    pdf = _open(out)
    try:
        assert pdf.allow.modify_form is form
        assert pdf.allow.modify_annotation is annot
        assert pdf.allow.modify_other is other
    finally:
        pdf.close()


@pytest.mark.parametrize("permissions", [
    {"print": "none", "copy": False, "modify": "none"},
    {"print": "none", "copy": False, "modify": "none", "accessibility": False},
])
def test_accessibility_is_never_restricted(fixture_bytes, permissions):
    """Acceptance criterion. A screen reader is not a threat model, and the
    "copy" bit it would ride along with is advisory anyway — so a client asking
    for it to be off is ignored rather than obeyed."""
    out = S.encrypt(fixture_bytes("text.pdf"), owner_password="o",
                    permissions=permissions)
    pdf = _open(out)
    try:
        assert pdf.allow.accessibility is True
    finally:
        pdf.close()


def test_a_nonsense_permission_level_is_refused(fixture_bytes):
    with pytest.raises(InvalidParams):
        S.encrypt(fixture_bytes("text.pdf"), owner_password="o",
                  permissions={"print": "sometimes"})


def test_decrypt_round_trips(fixture_bytes):
    original = fixture_bytes("text.pdf")
    locked = S.encrypt(original, owner_password="owner", user_password="user")
    unlocked = S.decrypt(locked, password="user")

    assert not S.is_encrypted(unlocked)
    doc = fitz.open(stream=unlocked, filetype="pdf")
    try:
        assert doc.page_count == 3
        assert "quick brown fox" in doc[0].get_text()
    finally:
        doc.close()


def test_the_wrong_password_is_its_own_error(fixture_bytes):
    locked = S.encrypt(fixture_bytes("text.pdf"), owner_password="owner",
                       user_password="user")
    with pytest.raises(EngineError) as exc:
        S.decrypt(locked, password="not-it")
    assert exc.value.code == "invalid_password"


def test_decrypting_an_unprotected_document_says_so(fixture_bytes):
    with pytest.raises(InvalidParams, match="not password-protected"):
        S.decrypt(fixture_bytes("text.pdf"))


def test_permissions_can_be_changed_with_the_owner_password(fixture_bytes):
    locked = S.encrypt(fixture_bytes("text.pdf"), owner_password="owner",
                       permissions={"print": "none"})
    relaxed = S.set_permissions(locked, owner_password="owner",
                                permissions={"print": "full", "copy": True},
                                password="owner")
    pdf = _open(relaxed)
    try:
        assert pdf.allow.print_highres is True
    finally:
        pdf.close()


def test_the_read_model_reports_what_the_file_allows(fixture_bytes):
    out = S.encrypt(fixture_bytes("text.pdf"), owner_password="o",
                    permissions={"print": "lowres", "copy": False,
                                 "modify": "form_fill"})
    assert S.read_permissions(out) == {
        "encrypted": True, "print": "lowres", "copy": False,
        "modify": "form_fill", "accessibility": True,
    }
    assert S.read_permissions(fixture_bytes("text.pdf")) == {"encrypted": False}


def test_open_with_password_is_the_one_place_the_pipeline_unlocks(fixture_bytes):
    plain = fixture_bytes("text.pdf")
    assert S.open_with_password(plain) is plain

    locked = S.encrypt(plain, owner_password="o", user_password="u")
    from apps.pdf_engine.exceptions import DocumentEncryptedError

    with pytest.raises(DocumentEncryptedError):
        S.open_with_password(locked)
    assert not S.is_encrypted(S.open_with_password(locked, "u"))


# --------------------------------------------------------------------------- #
# Sanitize
# --------------------------------------------------------------------------- #
def test_sanitize_removes_the_booby_traps_and_counts_them(fixture_bytes):
    """Acceptance criterion: the report is accurate against a fixture that
    carries JavaScript, an attachment and metadata."""
    out, report = S.sanitize(fixture_bytes("booby-trapped.pdf"),
                             metadata=True, xmp=True, javascript=True,
                             embedded_files=True)
    assert report["javascript"] >= 2, report      # /OpenAction + the name tree
    assert report["embedded_files"] >= 1, report
    assert report["metadata"] >= 1, report
    assert report["total"] == sum(report[k] for k in S.SANITIZE_ITEMS)

    pdf = _open(out)
    try:
        assert "/OpenAction" not in pdf.Root
        names = pdf.Root.get("/Names")
        assert names is None or "/JavaScript" not in names
        assert names is None or "/EmbeddedFiles" not in names
        assert "/Metadata" not in pdf.Root
        assert not (pdf.docinfo and len(pdf.docinfo.keys()))
    finally:
        pdf.close()

    # …and the *bytes* no longer carry the script or the attachment.
    assert b"app.alert" not in out
    assert b"attached secret" not in out


def test_sanitize_leaves_the_document_readable(fixture_bytes):
    out, _ = S.sanitize(fixture_bytes("booby-trapped.pdf"), javascript=True,
                        metadata=True)
    doc = fitz.open(stream=out, filetype="pdf")
    try:
        assert "ordinary invoice" in doc[0].get_text()
    finally:
        doc.close()


def test_sanitize_strips_outbound_links_but_not_the_page(fixture_bytes):
    out, report = S.sanitize(fixture_bytes("booby-trapped.pdf"),
                             links_external=True)
    assert report["links_external"] == 1
    doc = fitz.open(stream=out, filetype="pdf")
    try:
        assert doc[0].get_links() == []
        assert "ordinary invoice" in doc[0].get_text()
    finally:
        doc.close()


def test_sanitize_removes_comments_when_asked(fixture_bytes):
    from apps.pdf_engine.engine.annotations import apply_annotation_ops

    marked, _ = apply_annotation_ops(fixture_bytes("text.pdf"), ops=[{
        "action": "add",
        "annotation": {"id": "note-1", "type": "note", "page": 0,
                       "rect": {"x": 0.1, "y": 0.1, "w": 0.03, "h": 0.03},
                       "contents": "internal remark"},
    }], author="Tester")

    out, report = S.sanitize(marked, comments=True)
    assert report["comments"] >= 1
    assert b"internal remark" not in out


def test_sanitize_needs_something_to_do(fixture_bytes):
    with pytest.raises(InvalidParams, match="at least one"):
        S.sanitize(fixture_bytes("text.pdf"))


def test_sanitize_only_removes_what_was_asked_for(fixture_bytes):
    """A checklist that quietly does more than it says is worse than one that
    does less: a user who kept their metadata deliberately would not find out."""
    out, report = S.sanitize(fixture_bytes("booby-trapped.pdf"), javascript=True)
    assert report["metadata"] == 0
    assert report["embedded_files"] == 0
    pdf = _open(out)
    try:
        assert pdf.docinfo and len(pdf.docinfo.keys()), "metadata was taken uninvited"
    finally:
        pdf.close()
