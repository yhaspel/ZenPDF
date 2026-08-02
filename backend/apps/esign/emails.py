"""Signing emails (phase-08 §8B, §15).

Plain text, deliberately: an invitation to sign a document is exactly the shape
of a phishing mail, and the more it looks like a bank's marketing template the
harder it is for a recipient to tell the difference. Every message says who
sent it, what it is about, and carries one link.

Dev delivers to Mailpit; production deliverability (SPF/DKIM) is a phase-10
checklist item.
"""
from __future__ import annotations

import logging

from django.conf import settings
from django.core.mail import send_mail
from django.utils import timezone

logger = logging.getLogger(__name__)


def sign_url(recipient) -> str:
    return f"{settings.FRONTEND_BASE_URL}/s/{recipient.token}"


def _sender_name(sign_request) -> str:
    sender = sign_request.owner
    return (getattr(sender, "display_name", "") or "").strip() or sender.email


def _send(subject: str, body: str, to: list[str]) -> None:
    if not to:
        return
    try:
        send_mail(subject, body, settings.DEFAULT_FROM_EMAIL, to,
                  fail_silently=False)
    except Exception:  # noqa: BLE001 - a bounced invite must not fail the job
        logger.exception("esign: could not send %r to %s", subject, to)


def notify_recipients(sign_request, recipients) -> None:
    """"Please sign" — the one email that has to be trusted by a stranger."""
    sender = _sender_name(sign_request)
    for recipient in recipients:
        greeting = f"Hello {recipient.name}," if recipient.name else "Hello,"
        action = {
            "signer": "sign",
            "approver": "approve",
            "viewer": "view",
        }.get(recipient.role, "open")
        lines = [
            greeting,
            "",
            f"{sender} has asked you to {action} a document: {sign_request.title}",
        ]
        if sign_request.message:
            lines += ["", f'Their message: "{sign_request.message}"']
        lines += [
            "",
            f"Open it here: {sign_url(recipient)}",
            "",
            f"Envelope {sign_request.envelope_code}.",
        ]
        if sign_request.expires_at:
            lines.append(
                f"This link expires on {sign_request.expires_at:%d %B %Y}."
            )
        lines += [
            "",
            "If you were not expecting this, you can ignore this email — "
            "nothing happens until you open the link and agree.",
        ]
        _send(f"{sender} would like you to {action}: {sign_request.title}",
              "\n".join(lines), [recipient.email])
        recipient.last_notified_at = timezone.now()
        recipient.status = recipient.Status.NOTIFIED \
            if recipient.status == recipient.Status.PENDING else recipient.status
        recipient.save(update_fields=["last_notified_at", "status"])


def notify_reminder(sign_request, recipient) -> None:
    sender = _sender_name(sign_request)
    body = "\n".join([
        f"Hello {recipient.name}," if recipient.name else "Hello,",
        "",
        f"A reminder that {sender} is waiting for you on: {sign_request.title}",
        "",
        f"Open it here: {sign_url(recipient)}",
        "",
        f"Envelope {sign_request.envelope_code}.",
    ])
    _send(f"Reminder: {sign_request.title}", body, [recipient.email])
    recipient.last_notified_at = timezone.now()
    recipient.save(update_fields=["last_notified_at"])


def notify_declined(sign_request, decliner) -> None:
    """Everyone who has already acted is told, not just the owner.

    Somebody who signed an hour ago has a right to know the document will not
    be completed — silence there is how people end up believing a deal closed.
    """
    reason = decliner.decline_reason or "(no reason given)"
    who = decliner.name or decliner.email
    body = "\n".join([
        f"{who} declined to sign \"{sign_request.title}\".",
        "",
        f"Reason: {reason}",
        "",
        "The request has been stopped. Nobody else will be asked to sign it, "
        "and no completed document will be produced.",
        f"Envelope {sign_request.envelope_code}.",
    ])
    already = [r.email for r in sign_request.recipients.all()
               if r.status == r.Status.COMPLETED]
    _send(f"Declined: {sign_request.title}", body,
          list({sign_request.owner.email, *already}))


def notify_completed(sign_request, *, final_url: str, certificate_url: str) -> None:
    """Everyone, including cc. The links are tokenized per recipient."""
    lines = [
        f"\"{sign_request.title}\" is complete — everyone has signed.",
        "",
        f"Envelope {sign_request.envelope_code}",
        f"Document fingerprint (SHA-256): {sign_request.final_sha256}",
        "",
        "Keep a copy for your records:",
    ]
    for recipient in sign_request.recipients.all():
        body = "\n".join(lines + [
            f"  Signed document: {final_url.format(token=recipient.token)}",
            f"  Certificate of completion: "
            f"{certificate_url.format(token=recipient.token)}",
            "",
            "The certificate lists every action taken, with times and "
            "addresses, and the fingerprint above identifies the exact file.",
        ])
        _send(f"Completed: {sign_request.title}", body, [recipient.email])

    owner_body = "\n".join(lines + [
        f"  {settings.FRONTEND_BASE_URL}/app/sign/{sign_request.id}",
    ])
    _send(f"Completed: {sign_request.title}", owner_body, [sign_request.owner.email])


def notify_expired(sign_request, pending) -> None:
    body = "\n".join([
        f"\"{sign_request.title}\" has expired without being completed.",
        "",
        f"Envelope {sign_request.envelope_code}.",
        "Nobody can sign it now. Send it again if it is still needed.",
    ])
    _send(f"Expired: {sign_request.title}", body,
          list({sign_request.owner.email, *[r.email for r in pending]}))
