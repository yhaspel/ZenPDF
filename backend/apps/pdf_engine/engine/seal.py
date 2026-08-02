"""PAdES sealing and verification with pyHanko (phase-08 §8B step 3, §8C).

The seal is the platform's, not the signer's. What it proves is narrow and
worth stating exactly: *this file is byte-for-byte the one ZenPDF produced when
the envelope completed*. Who signed, when, and from where is established by the
audit trail and printed on the certificate; the seal is what makes tampering
with either detectable.

Levels, in the order we take them:

* **B-B** — a plain CMS signature. Always available.
* **B-T** — B-B plus an RFC 3161 timestamp from `TSA_URL`, which is what makes
  "signed before this moment" independent of our own clock.

B-LT (long-term validation material) needs a real CA chain with revocation
endpoints; with a self-signed dev certificate there is nothing to embed, and
claiming the level anyway would be a lie told in a field name. It is detected,
not assumed.
"""
from __future__ import annotations

import io
import logging

from django.conf import settings

from ..exceptions import EngineError

logger = logging.getLogger(__name__)

SEAL_FIELD_NAME = "ZenPDF-Seal"


def _signer():
    from pyhanko.sign import signers

    path = settings.SIGNING_CERT_PATH
    try:
        return signers.SimpleSigner.load_pkcs12(
            pfx_file=path,
            passphrase=(settings.SIGNING_CERT_PASSWORD or "").encode() or None,
        )
    except FileNotFoundError as exc:
        raise EngineError(
            "The signing certificate is missing. A completed document cannot "
            "be sealed without it.", code="engine_error",
        ) from exc
    except Exception as exc:  # noqa: BLE001
        raise EngineError(f"The signing certificate could not be loaded: {exc}",
                          code="engine_error") from exc


def _timestamper():
    url = (settings.TSA_URL or "").strip()
    if not url:
        return None
    from pyhanko.sign.timestamps import HTTPTimeStamper

    return HTTPTimeStamper(url)


def seal(data: bytes, *, reason: str, location: str = "") -> tuple[bytes, dict]:
    """Apply an invisible PAdES signature. Returns (bytes, report)."""
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
    from pyhanko.sign import signers
    from pyhanko.sign.fields import SigFieldSpec, append_signature_field

    signer = _signer()
    timestamper = _timestamper()

    writer = IncrementalPdfFileWriter(io.BytesIO(data))
    # An invisible field: the visual evidence of signing is the burnt-in
    # signature images and the certificate, not a widget the reader has to know
    # how to interpret.
    append_signature_field(writer, SigFieldSpec(sig_field_name=SEAL_FIELD_NAME))

    meta = signers.PdfSignatureMetadata(
        field_name=SEAL_FIELD_NAME,
        reason=reason,
        location=location or settings.FRONTEND_BASE_URL,
        # `subfilter` left to pyHanko's PAdES default for the chosen level.
    )
    out = io.BytesIO()
    try:
        signers.sign_pdf(writer, meta, signer=signer, timestamper=timestamper,
                         output=out)
    except Exception as exc:  # noqa: BLE001
        raise EngineError(f"The document could not be sealed: {exc}",
                          code="engine_error") from exc
    return out.getvalue(), {
        "sealed": True,
        "level": "B-T" if timestamper else "B-B",
        "field": SEAL_FIELD_NAME,
        "timestamped": bool(timestamper),
    }


def verify(data: bytes) -> dict:
    """Validate every signature in a PDF (§8C `/verify`).

    Deliberately generous about *what* it will look at — this endpoint exists
    for a person who has been sent a PDF and wants to know whether to trust it,
    and "this file has no signature at all" is a useful answer, not an error.
    """
    from pyhanko.pdf_utils.reader import PdfFileReader
    from pyhanko.sign.validation import validate_pdf_signature

    try:
        reader = PdfFileReader(io.BytesIO(data))
    except Exception as exc:  # noqa: BLE001
        raise EngineError(f"That file could not be read as a PDF: {exc}",
                          code="unsupported_file") from exc

    signatures = list(reader.embedded_signatures or [])
    if not signatures:
        return {"sealed": False, "signatures": [], "integrity": "unsigned"}

    results = []
    for embedded in signatures:
        try:
            status = validate_pdf_signature(embedded)
            covered = status.coverage
            results.append({
                "field": embedded.field_name,
                "signer": _common_name(status),
                "intact": bool(status.intact),
                "valid": bool(status.valid),
                # `coverage` is an enum; its name is the honest wording.
                "coverage": getattr(covered, "name", str(covered)),
                "whole_document": getattr(covered, "name", "") == "ENTIRE_FILE",
                "signing_time": (status.signer_reported_dt.isoformat()
                                 if status.signer_reported_dt else None),
                "timestamp": bool(getattr(status, "timestamp_validity", None)),
                "trusted": bool(getattr(status, "trusted", False)),
                "reason": _reason(embedded),
            })
        except Exception as exc:  # noqa: BLE001
            logger.info("verify: signature %s could not be validated: %s",
                        embedded.field_name, exc)
            results.append({
                "field": embedded.field_name, "signer": "", "intact": False,
                "valid": False, "coverage": "UNKNOWN", "whole_document": False,
                "signing_time": None, "timestamp": False, "trusted": False,
                "reason": "", "error": str(exc)[:200],
            })

    intact = all(r["intact"] for r in results)
    return {
        "sealed": True,
        "signatures": results,
        "integrity": "intact" if intact else "modified",
    }


def _common_name(status) -> str:
    try:
        return str(status.signing_cert.subject.native.get("common_name", "") or "")
    except Exception:  # noqa: BLE001 - a name we cannot read is not a failure
        return ""


def _reason(embedded) -> str:
    try:
        return str(embedded.sig_object.get("/Reason", "") or "")
    except Exception:  # noqa: BLE001
        return ""


def find_envelope_code(data: bytes) -> str:
    """Read the `Envelope ZEN-XXXXXX` stamp back off a page footer.

    The verification page uses it to look the envelope up in our own records —
    which is what turns "this file has a valid seal" into "this is envelope
    ZEN-8F3KQ2, completed on the 2nd, and here is its fingerprint".
    """
    import re

    import fitz

    doc = fitz.open(stream=data, filetype="pdf")
    try:
        for page in doc:
            match = re.search(r"\bZEN-[A-Z2-9]{6}\b", page.get_text())
            if match:
                return match.group(0)
        return ""
    finally:
        doc.close()
