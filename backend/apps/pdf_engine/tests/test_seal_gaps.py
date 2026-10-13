"""The seal's failure paths (phase-08 §8B/§8C).

Sealing is the last step of finalize, and `test_sign_api.py` proves the happy
path end to end. What it cannot prove is what the worker is told when the
certificate is missing, unreadable, or the signer blows up mid-sign — every
one of those has to surface as an `EngineError` with a stable code, because
that code is what lands on the job and in the audit trail. The verify side is
the mirror image: a signature pyHanko cannot validate must still be *listed*,
with an error, rather than dropped from the report.
"""
from unittest import mock

import pytest

from apps.pdf_engine.engine import seal as SEAL
from apps.pdf_engine.exceptions import EngineError


# --------------------------------------------------------------------------- #
# Loading the certificate
# --------------------------------------------------------------------------- #
def test_a_missing_certificate_is_named_as_missing(settings):
    settings.SIGNING_CERT_PATH = "/nowhere/zenpdf.p12"
    with mock.patch("pyhanko.sign.signers.SimpleSigner.load_pkcs12",
                    side_effect=FileNotFoundError("/nowhere/zenpdf.p12")):
        with pytest.raises(EngineError) as caught:
            SEAL._signer()
    assert caught.value.code == "engine_error"
    assert "certificate is missing" in str(caught.value)


def test_a_certificate_that_will_not_load_is_a_different_message(settings):
    """A wrong passphrase or a corrupt file is not "missing", and telling an
    operator the wrong thing costs them the time it takes to find the file
    that is already there."""
    with mock.patch("pyhanko.sign.signers.SimpleSigner.load_pkcs12",
                    side_effect=ValueError("Could not deserialize PKCS12 data")):
        with pytest.raises(EngineError) as caught:
            SEAL._signer()
    assert caught.value.code == "engine_error"
    assert "could not be loaded" in str(caught.value)
    assert "PKCS12" in str(caught.value)


def test_the_passphrase_is_passed_as_bytes_and_an_empty_one_as_none(settings):
    settings.SIGNING_CERT_PATH = "/certs/x.p12"
    with mock.patch("pyhanko.sign.signers.SimpleSigner.load_pkcs12") as load:
        settings.SIGNING_CERT_PASSWORD = "devpass"
        SEAL._signer()
        settings.SIGNING_CERT_PASSWORD = ""
        SEAL._signer()
    first, second = load.call_args_list
    assert first.kwargs == {"pfx_file": "/certs/x.p12", "passphrase": b"devpass"}
    assert second.kwargs == {"pfx_file": "/certs/x.p12", "passphrase": None}


# --------------------------------------------------------------------------- #
# The timestamper
# --------------------------------------------------------------------------- #
def test_no_tsa_url_means_no_timestamper(settings):
    settings.TSA_URL = "   "
    assert SEAL._timestamper() is None


def test_a_tsa_url_builds_an_http_timestamper_on_the_trimmed_url(settings):
    from pyhanko.sign.timestamps import HTTPTimeStamper

    settings.TSA_URL = "  https://tsa.example.org/tsr  "
    stamper = SEAL._timestamper()
    assert isinstance(stamper, HTTPTimeStamper)
    assert stamper.url == "https://tsa.example.org/tsr"


def test_the_report_calls_the_level_b_t_only_when_a_timestamper_was_used(fixture_bytes):
    """The level is recorded as evidence; it has to describe the file."""
    stamper = mock.Mock(name="timestamper")
    with mock.patch.object(SEAL, "_timestamper", return_value=stamper), \
            mock.patch("pyhanko.sign.signers.sign_pdf") as sign:
        _out, report = SEAL.seal(fixture_bytes("text.pdf"), reason="test")
    assert sign.call_args.kwargs["timestamper"] is stamper
    assert report["level"] == "B-T" and report["timestamped"] is True


# --------------------------------------------------------------------------- #
# Sealing
# --------------------------------------------------------------------------- #
def test_a_signer_failure_is_wrapped_not_leaked(fixture_bytes):
    with mock.patch("pyhanko.sign.signers.sign_pdf",
                    side_effect=RuntimeError("TSA returned 500")):
        with pytest.raises(EngineError) as caught:
            SEAL.seal(fixture_bytes("text.pdf"), reason="Envelope completed")
    assert caught.value.code == "engine_error"
    assert "could not be sealed" in str(caught.value)
    assert "TSA returned 500" in str(caught.value)


def test_a_seal_without_a_certificate_fails_before_touching_the_document(fixture_bytes):
    with mock.patch.object(SEAL, "_signer",
                           side_effect=EngineError("missing", code="engine_error")), \
            mock.patch("pyhanko.sign.signers.sign_pdf") as sign:
        with pytest.raises(EngineError, match="missing"):
            SEAL.seal(fixture_bytes("text.pdf"), reason="r")
    sign.assert_not_called()


def test_the_location_defaults_to_the_frontend_url(fixture_bytes, settings):
    settings.FRONTEND_BASE_URL = "https://zenpdf.example"
    with mock.patch("pyhanko.sign.signers.sign_pdf"):
        with mock.patch("pyhanko.sign.signers.PdfSignatureMetadata") as meta:
            SEAL.seal(fixture_bytes("text.pdf"), reason="r")
            SEAL.seal(fixture_bytes("text.pdf"), reason="r", location="Tel Aviv")
    first, second = meta.call_args_list
    assert first.kwargs["location"] == "https://zenpdf.example"
    assert second.kwargs["location"] == "Tel Aviv"


# --------------------------------------------------------------------------- #
# Verify
# --------------------------------------------------------------------------- #
def test_a_signature_that_cannot_be_validated_is_listed_with_its_error(fixture_bytes):
    """Dropping it would turn "we could not check this" into "there was
    nothing to check" — the opposite of what the reader needs to know."""
    sealed, _ = SEAL.seal(fixture_bytes("text.pdf"), reason="Envelope completed")
    with mock.patch("pyhanko.sign.validation.validate_pdf_signature",
                    side_effect=ValueError("unsupported digest")):
        report = SEAL.verify(sealed)

    assert report["sealed"] is True
    assert len(report["signatures"]) == 1
    entry = report["signatures"][0]
    assert entry["field"] == SEAL.SEAL_FIELD_NAME
    assert entry["error"] == "unsupported digest"
    assert entry["intact"] is False and entry["valid"] is False
    assert entry["coverage"] == "UNKNOWN"
    # An unvalidated signature can never make the document "intact".
    assert report["integrity"] == "modified"
    assert report["appended_after_signing"] is False


def test_a_validation_error_message_is_bounded(fixture_bytes):
    sealed, _ = SEAL.seal(fixture_bytes("text.pdf"), reason="r")
    with mock.patch("pyhanko.sign.validation.validate_pdf_signature",
                    side_effect=ValueError("x" * 1000)):
        report = SEAL.verify(sealed)
    assert len(report["signatures"][0]["error"]) == 200


def test_a_file_that_is_not_a_pdf_is_an_unsupported_file():
    with pytest.raises(EngineError) as caught:
        SEAL.verify(b"this is a text file")
    assert caught.value.code == "unsupported_file"


def test_a_signer_name_that_cannot_be_read_is_blank_not_fatal():
    class _Status:
        @property
        def signing_cert(self):
            raise AttributeError("no certificate in status")

    assert SEAL._common_name(_Status()) == ""
    assert SEAL._common_name(object()) == ""


def test_a_reason_that_cannot_be_read_is_blank_not_fatal():
    class _Embedded:
        @property
        def sig_object(self):
            raise KeyError("/V")

    assert SEAL._reason(_Embedded()) == ""
    assert SEAL._reason(object()) == ""


def test_the_reason_is_read_back_off_a_real_seal(fixture_bytes):
    sealed, _ = SEAL.seal(fixture_bytes("text.pdf"), reason="Envelope ZEN-TEST01 completed")
    report = SEAL.verify(sealed)
    assert report["signatures"][0]["reason"] == "Envelope ZEN-TEST01 completed"
