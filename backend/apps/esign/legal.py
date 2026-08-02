"""The ESIGN/UETA consent disclosure (phase-08 acceptance criterion 5).

The exact text a signer agrees to is **versioned in this repository** and its
SHA-256 is written into the audit trail at the moment of consent. That is what
makes the record meaningful a year later: without it, "the signer consented"
means "consented to whatever the site said at the time", which nobody can
reconstruct.

Change the text and you must change `VERSION` with it — the test enforces that
the hash of the shipped text matches the one recorded alongside the version.
"""
from __future__ import annotations

import hashlib

VERSION = "2026-08-02"

DISCLOSURE = """\
Consent to use electronic records and signatures

By continuing, you agree to sign this document electronically and to receive
records about it electronically.

1. Your signature. When you draw, type or upload a signature and complete this
   document, that mark is your signature. It has the same legal effect as a
   signature written by hand under the U.S. ESIGN Act and UETA, and equivalent
   rules in many other jurisdictions.

2. What is recorded. We record when you opened the document, when you agreed
   to this notice, what you filled in, when you completed it, your IP address
   and your browser's user-agent string. That record is printed on a
   certificate of completion attached to the finished document, and every
   entry in it is linked to the one before it so that changing any of them is
   detectable.

3. Getting a copy. When everyone has signed you will be emailed a link to the
   completed document and its certificate. Download and keep them; that is
   your copy of the record. You can ask the sender for another copy at any
   time.

4. Signing on paper instead. You do not have to sign electronically. If you
   would rather sign on paper, do not continue — tell the sender, and arrange
   it with them directly.

5. Withdrawing. You may stop at any time before you complete the document by
   using the "Decline to sign" link, which tells the sender and ends the
   request. After you complete it, the document is signed and this consent
   cannot be withdrawn for that document.

6. What you need. A device with a modern web browser, an internet connection,
   a working email address, and the ability to open and save PDF files.

7. Who you are agreeing with. The sender is the person or organisation named
   in the invitation you received. ZenPDF operates the signing service and
   seals the completed document; ZenPDF is not a party to your agreement.

This is a simple electronic signature with a platform seal. It is not a
qualified electronic signature (QES) and we make no such claim.
"""


def disclosure_hash() -> str:
    """SHA-256 of the exact bytes above, recorded with every consent event."""
    return hashlib.sha256(DISCLOSURE.encode()).hexdigest()


def consent_metadata() -> dict:
    return {"disclosure_version": VERSION, "disclosure_sha256": disclosure_hash()}
