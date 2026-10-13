"""`page_words` refusals (phase-03; §8).

The word grid is the first engine call the viewer makes on a page, so the
errors it raises are the ones the client has to turn into a message. Bytes
that are not a PDF and a document that needs a password each have a code of
their own; a bare PyMuPDF exception would reach the user as a 500.
"""
import pytest

from apps.pdf_engine.engine import text as T
from apps.pdf_engine.exceptions import DocumentEncryptedError, UnsupportedFileError


def test_bytes_that_are_not_a_pdf_are_an_unsupported_file():
    with pytest.raises(UnsupportedFileError) as caught:
        T.page_words(b"\x00\x01 not a pdf \xff\xfe", 0)
    assert caught.value.code == "unsupported_file"
    assert "Could not open" in str(caught.value)


def test_an_encrypted_document_asks_to_be_unlocked_first(fixture_bytes):
    with pytest.raises(DocumentEncryptedError) as caught:
        T.page_words(fixture_bytes("encrypted.pdf"), 0)
    assert caught.value.code == "document_encrypted"
    assert "unlock" in str(caught.value)
