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
"""
from __future__ import annotations

import logging

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.core.signing import TimestampSigner

logger = logging.getLogger(__name__)

UNSUBSCRIBE_SALT = "zenpdf.unsubscribe"


def unsubscribe_token(email: str) -> str:
    return TimestampSigner(salt=UNSUBSCRIBE_SALT).sign(email.lower())


def email_from_unsubscribe_token(token: str, *, max_age_days: int = 365) -> str:
    from django.core.signing import BadSignature, SignatureExpired

    signer = TimestampSigner(salt=UNSUBSCRIBE_SALT)
    try:
        return signer.unsign(token, max_age=max_age_days * 86400)
    except (BadSignature, SignatureExpired):
        return ""


def is_suppressed(email: str) -> bool:
    from .models import EmailSuppression

    return EmailSuppression.objects.filter(email=email.lower()).exists()


def suppress(email: str, reason: str = "unsubscribe") -> None:
    from .models import EmailSuppression

    EmailSuppression.objects.get_or_create(
        email=email.lower(), defaults={"reason": reason},
    )


def _footer(email: str) -> str:
    unsubscribe = (f"{settings.FRONTEND_BASE_URL}/unsubscribe/"
                   f"{unsubscribe_token(email)}")
    return (
        "\n\n—\n"
        f"Sent by ZenPDF. If this was not meant for you, tell us: "
        f"{settings.ABUSE_CONTACT_EMAIL}\n"
        f"Stop receiving these: {unsubscribe}\n"
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
            link = (f"{settings.FRONTEND_BASE_URL}/unsubscribe/"
                    f"{unsubscribe_token(address)}")
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
