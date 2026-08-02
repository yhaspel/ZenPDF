"""The hostile corpus (phase-10 §10.1).

Every file here is *shaped* like an attack rather than being large enough to
hurt — the point is that the guard fires, not that a laptop suffers. The
fixtures are built by the committed generator, so they can be inspected and
rebuilt rather than trusted.

What each one is actually asking:

* **page-bomb** — does a self-referential page tree terminate?
* **deep-outline** — does metadata we read at ingest stay bounded?
* **stream-bomb** — does anything inflate an 80 MB stream because it was there?
* **zip-bomb.docx** — is a gigabyte refused *before* LibreOffice is handed it?
* **malformed.tiff** — does a broken image fail as a message, not a crash?

A guard that raises `UnsupportedFileError` is a pass. A guard that takes ten
minutes, or allocates a gigabyte, is a failure even if it eventually answers.
"""
from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from apps.pdf_engine.exceptions import EngineError, UnsupportedFileError

FIXTURES = Path(__file__).resolve().parents[3] / "tests" / "fixtures"
PDFS = FIXTURES / "pdfs"

#: Nothing in this file should take longer than a person would wait, and the
#: worker's own time limit is 600 s — a guard that needs more than this is not
#: a guard.
BUDGET_SECONDS = 30
#: How much *this* piece of work may add. A deliberate delta rather than a
#: ceiling on total RSS: `ru_maxrss` is a high-water mark for the whole process,
#: so after a full suite run it is already past any sensible ceiling and the
#: assertion would fire on tests that behaved perfectly.
BUDGET_RSS_GROWTH_MB = 300


def _rss_mb() -> float:
    """Resident set size *now*, from /proc — Linux only, which the tests are."""
    with open("/proc/self/statm") as handle:
        resident_pages = int(handle.read().split()[1])
    return resident_pages * os.sysconf("SC_PAGE_SIZE") / (1024 * 1024)


class _Budget:
    """Fails the test if the work took unreasonable time or memory."""

    def __enter__(self):
        self.started = time.monotonic()
        self.rss_before = _rss_mb()
        return self

    def __exit__(self, *exc):
        elapsed = time.monotonic() - self.started
        growth = _rss_mb() - self.rss_before
        assert elapsed < BUDGET_SECONDS, f"took {elapsed:.1f}s"
        assert growth < BUDGET_RSS_GROWTH_MB, f"grew {growth:.0f} MB"
        return False


def _read(name: str) -> bytes:
    return (PDFS / name).read_bytes()


# --------------------------------------------------------------------------- #
# Structure bombs
# --------------------------------------------------------------------------- #
def test_a_self_referential_page_tree_is_refused_quickly():
    """`/Count` claims a million pages and `/Kids` is a cycle."""
    from apps.pdf_engine.engine.validate import validate_pdf

    with _Budget(), pytest.raises(UnsupportedFileError):
        validate_pdf(_read("page-bomb.pdf"))


def test_a_deeply_nested_outline_does_not_blow_the_stack():
    """Ten thousand levels of bookmark. Whatever comes back, it must be
    bounded and it must not recurse into a crash."""
    from apps.pdf_engine.engine.validate import validate_pdf

    with _Budget():
        info = validate_pdf(_read("deep-outline.pdf"))
    assert info["pages"] == 1
    assert len(info["toc"]) <= 5000


def test_a_decompression_bomb_is_not_inflated_by_validation():
    """80 MB of nothing, deflated to a few kilobytes. Reading the page count
    must not mean reading the payload."""
    from apps.pdf_engine.engine.validate import validate_pdf

    with _Budget():
        info = validate_pdf(_read("stream-bomb.pdf"))
    assert info["pages"] == 1


def test_a_decompression_bomb_survives_a_sanitize_pass():
    """Sanitize walks every object looking for JavaScript and attachments —
    the pass most likely to inflate a stream because it was there."""
    from apps.pdf_engine.engine.security import sanitize

    with _Budget():
        out, report = sanitize(_read("stream-bomb.pdf"), attachments=True,
                               javascript=True, metadata=True)
    assert out.startswith(b"%PDF-")


# --------------------------------------------------------------------------- #
# Archive bombs — the office import path
# --------------------------------------------------------------------------- #
def test_a_zip_bomb_is_refused_before_libreoffice_sees_it():
    """A 1 MB .docx that declares a gigabyte. The central directory says so
    before anything unpacks it, which is the moment to refuse."""
    from apps.pdf_engine.engine.convert import check_archive

    data = (PDFS / "zip-bomb.docx").read_bytes()
    with _Budget(), pytest.raises(UnsupportedFileError) as exc:
        check_archive(data, "zip-bomb.docx")
    assert "more than we will convert" in str(exc.value)


def test_a_padded_zip_bomb_is_refused_too():
    """The evasion the first version of this guard fell to.

    It compared the *declared* uncompressed size against the upload size, and
    both numbers are the uploader's to choose: two megabytes of incompressible
    padding drags the ratio under the threshold while the payload stays
    enormous. One such upload pinned Gotenberg at 1.4 GB until somebody
    restarted it by hand.
    """
    import io
    import os
    import zipfile

    from apps.pdf_engine.engine.convert import check_archive

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        with archive.open("word/document.xml", "w") as entry:
            entry.write(b"<w:p>text</w:p>" * (40 * 1024 * 1024 // 15))
        # Stored, not deflated: this is the padding that fixes the ratio.
        archive.writestr(zipfile.ZipInfo("word/media/pad.bin"),
                         os.urandom(2 * 1024 * 1024),
                         compress_type=zipfile.ZIP_STORED)
    data = buf.getvalue()

    from apps.pdf_engine.engine import convert

    # A 40 MB payload is well under the real cap, so the cap is lowered rather
    # than the fixture being made cruel — the point is the *mechanism*.
    original = convert.MAX_ARCHIVE_UNCOMPRESSED_BYTES
    convert.MAX_ARCHIVE_UNCOMPRESSED_BYTES = 8 * 1024 * 1024
    try:
        with _Budget(), pytest.raises(UnsupportedFileError):
            check_archive(data, "padded.docx")
    finally:
        convert.MAX_ARCHIVE_UNCOMPRESSED_BYTES = original


def test_a_zip_with_a_junk_prefix_is_still_inspected():
    """`zipfile` finds the directory by scanning backwards, so a file that does
    not start with `PK` still unpacks — and the first version of this guard
    returned early on exactly that check."""
    import io
    import zipfile

    from apps.pdf_engine.engine import convert
    from apps.pdf_engine.engine.convert import check_archive

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml", b"0" * (16 * 1024 * 1024))
    data = b"JUNKJUNK" + buf.getvalue()

    original = convert.MAX_ARCHIVE_UNCOMPRESSED_BYTES
    convert.MAX_ARCHIVE_UNCOMPRESSED_BYTES = 4 * 1024 * 1024
    try:
        with _Budget(), pytest.raises(UnsupportedFileError):
            check_archive(data, "prefixed.docx")
    finally:
        convert.MAX_ARCHIVE_UNCOMPRESSED_BYTES = original


def test_an_ordinary_office_file_is_not_mistaken_for_a_bomb():
    """The guard has to let real documents through, or it is just an outage."""
    import io
    import zipfile

    from apps.pdf_engine.engine.convert import check_archive

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml",
                         ("<w:p>Real content, compressible but honest.</w:p>"
                          * 500).encode())
    check_archive(buf.getvalue(), "real.docx")


def test_a_file_type_we_do_not_convert_never_reaches_storage():
    from apps.pdf_engine.engine.convert import kind_of

    for name in ("payload.zip", "installer.exe", "script.sh", "archive.tar.gz"):
        with pytest.raises(UnsupportedFileError):
            kind_of(name)


# --------------------------------------------------------------------------- #
# Malformed images
# --------------------------------------------------------------------------- #
def test_a_malformed_tiff_fails_as_a_message_not_a_crash():
    from apps.pdf_engine.engine.convert import images_to_pdf

    data = (FIXTURES / "images" / "malformed.tiff").read_bytes()
    with _Budget(), pytest.raises(EngineError):
        images_to_pdf([data])


def test_a_truncated_pdf_is_offered_repair_or_refused_cleanly():
    from apps.pdf_engine.engine.validate import validate_pdf

    data = _read("text.pdf")[: len(_read("text.pdf")) // 2]
    with _Budget():
        try:
            info = validate_pdf(data)
        except UnsupportedFileError:
            return  # refused cleanly, which is the other acceptable answer
    assert info["needs_repair"] is True
