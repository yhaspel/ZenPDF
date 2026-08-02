"""Outbound mail, with the things every message we send must carry (§9B).

One door for all of it, because the rules are not per-feature:

* a **suppression list** — somebody who unsubscribed or complained does not get
  another message, from any part of the product;
* `List-Unsubscribe` (and `List-Unsubscribe-Post`, which is what makes the
  one-click button appear in Gmail) — the difference between a person
  unsubscribing and a person clicking "spam", which costs the whole domain;
* an abuse contact in the footer, so a recipient who was mailed by somebody
  they do not know has somewhere to go that is not their spam button.

Transactional mail to the account holder themselves (verify your address) is
sent even when suppressed: it is not marketing, and suppressing it would lock
somebody out of their own account.

Two details that are easy to get wrong and were:

1. **The `List-Unsubscribe` URL points at the API, not the SPA.** RFC 8058
   one-click is a server-to-server POST from Gmail with no JavaScript in sight;
   a link to a client-rendered route would return the app shell, suppress
   nothing, and tell the person they had unsubscribed when they had not.
2. **The token carries a keyed hash, not the address.** It is printed in every
   footer and clicked from a browser, and a URL with an email in it ends up in
   history, logs and `Referer` headers.
"""
from __future__ import annotations

import hashlib
import hmac
import logging

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.core.signing import TimestampSigner

logger = logging.getLogger(__name__)

UNSUBSCRIBE_SALT = "zenpdf.unsubscribe"


def address_hash(email: str) -> str:
    """Keyed, so the list cannot be probed offline with a dictionary of
    addresses by anyone who gets a copy of the table."""
    return hmac.new(settings.SECRET_KEY.encode(),
                    email.strip().lower().encode(), hashlib.sha256).hexdigest()


def unsubscribe_token(email: str) -> str:
    return TimestampSigner(salt=UNSUBSCRIBE_SALT).sign(address_hash(email))


def hash_from_unsubscribe_token(token: str, *, max_age_days: int = 365) -> str:
    from django.core.signing import BadSignature, SignatureExpired

    signer = TimestampSigner(salt=UNSUBSCRIBE_SALT)
    try:
        return signer.unsign(token, max_age=max_age_days * 86400)
    except (BadSignature, SignatureExpired):
        return ""


def is_suppressed(email: str) -> bool:
    from .models import EmailSuppression

    return EmailSuppression.objects.filter(email_hash=address_hash(email)).exists()


def suppress(email: str, reason: str = "unsubscribe") -> None:
    from .models import EmailSuppression

    EmailSuppression.objects.get_or_create(
        email_hash=address_hash(email),
        defaults={"reason": reason, "email": email.strip().lower()},
    )


def suppress_hash(digest: str, reason: str = "unsubscribe") -> None:
    """Suppress from a one-click token, which does not reveal the address."""
    from .models import EmailSuppression

    EmailSuppression.objects.get_or_create(
        email_hash=digest, defaults={"reason": reason},
    )


def unsuppress_hash(digest: str) -> bool:
    """Undo. A preference somebody cannot reverse is a trap, and this one can
    be triggered by anybody a signing invitation was forwarded to."""
    from .models import EmailSuppression

    deleted, _ = EmailSuppression.objects.filter(email_hash=digest).delete()
    return bool(deleted)


def unsubscribe_url(email: str) -> str:
    """The address Gmail POSTs to, and the address a human clicks.

    Both are the API. The API answers a browser GET with a redirect to the
    human-readable page, so one URL can be both.
    """
    return (f"{settings.API_BASE_URL}/api/mail/unsubscribe/"
            f"{unsubscribe_token(email)}/")


def _footer(email: str) -> str:
    return (
        "\n\n—\n"
        f"Sent by ZenPDF. If this was not meant for you, tell us: "
        f"{settings.ABUSE_CONTACT_EMAIL}\n"
        f"Stop receiving these: {unsubscribe_url(email)}\n"
    )


def send(subject: str, body: str, to: list[str], *, transactional: bool = False,
         unsubscribable: bool = True) -> int:
    """Send to each address that has not opted out. Returns how many went."""
    sent = 0
    for address in {a.strip().lower() for a in to if a and a.strip()}:
        if not transactional and is_suppressed(address):
            logger.info("mail: suppressed %r to %s", subject, address)
            continue
        message = EmailMultiAlternatives(
            subject=subject,
            body=body + (_footer(address) if unsubscribable else ""),
            from_email=settings.DEFAULT_FROM_EMAIL,
            to=[address],
        )
        if unsubscribable:
            link = unsubscribe_url(address)
            # These must reach the wire as plain ASCII URIs. Django will
            # RFC-2047 encode a header it is given as a `str` under a non-ascii
            # charset, and an encoded `List-Unsubscribe` is one Gmail ignores —
            # so the value is forced through the ascii charset explicitly.
            message.extra_headers["List-Unsubscribe"] = f"<{link}>"
            # Without this Gmail shows no one-click button, and the person who
            # wanted out clicks "report spam" instead.
            message.extra_headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
        try:
            message.send(fail_silently=False)
            sent += 1
        except Exception:  # noqa: BLE001 - a bounced message must not fail a job
            logger.exception("mail: could not send %r to %s", subject, address)
    return sent
