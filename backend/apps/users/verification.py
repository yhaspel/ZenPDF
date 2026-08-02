"""Email verification (§9B).

A signed, expiring token rather than a table: there is nothing to store that
the signature does not already prove, and a row per attempt is a row somebody
has to clean up.

What it gates is narrow and deliberate: **sending a signature request**, and
claiming above the free storage tier. It must never gate *uploading* — a guest
uploads freely, so a verified-email-to-upload rule would make a registered
account strictly worse than staying anonymous, which is the wall §21 exists to
remove.
"""
from __future__ import annotations

from django.conf import settings
from django.core.signing import BadSignature, SignatureExpired, TimestampSigner

from apps.core import mail

SALT = "zenpdf.verify-email"


def verification_token(user) -> str:
    """Signs the user **id**, not the address.

    The token travels in a URL, and a URL carrying somebody's email address
    ends up in browser history, server logs and `Referer` headers on every
    link they click from that page.
    """
    return TimestampSigner(salt=SALT).sign(str(user.pk))


def user_from_verification_token(token: str):
    from django.contrib.auth import get_user_model

    signer = TimestampSigner(salt=SALT)
    try:
        user_id = signer.unsign(
            token, max_age=settings.EMAIL_VERIFICATION_TTL_HOURS * 3600)
    except (BadSignature, SignatureExpired):
        return None
    return get_user_model().objects.filter(pk=user_id).first()


def send_verification_email(user) -> None:
    link = f"{settings.FRONTEND_BASE_URL}/verify-email/{verification_token(user)}"
    body = "\n".join([
        f"Hello {user.display_name or ''}".rstrip() + ",",
        "",
        "Confirm this address so you can send documents for signature:",
        "",
        f"  {link}",
        "",
        f"The link works for {settings.EMAIL_VERIFICATION_TTL_HOURS} hours. "
        "You can keep using everything else in the meantime — this only "
        "unlocks sending documents to other people.",
    ])
    # Transactional: somebody who unsubscribed from signing mail still has to
    # be able to confirm their own address, or they are locked out of their
    # own account by a preference about somebody else's document.
    mail.send("Confirm your email address", body, [user.email],
              transactional=True, unsubscribable=False)
