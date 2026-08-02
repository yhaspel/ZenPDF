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
from django.utils import timezone

from apps.core import mail

logger = logging.getLogger(__name__)


def sign_url(recipient) -> str:
    return f"{settings.FRONTEND_BASE_URL}/s/{recipient.token}"


def _sender_name(sign_request) -> str:
    sender = sign_request.owner
    return (getattr(sender, "display_name", "") or "").strip() or sender.email


def _send(subject: str, body: str, to: list[str]) -> int:
    """Through `core.mail`: suppression list, `List-Unsubscribe`, abuse contact.

    A signing invitation is exactly the shape of a phishing mail, so the
    recipient needs somewhere to complain that is not their spam button — and
    somebody who has opted out must never be mailed again by any part of the
    product (§9B).

    Returns **how many messages actually went**, and callers must honour it: an
    e-signature audit trail that records an invitation the suppression list
    swallowed is the wrong kind of wrong.
    """
    if not to:
        return 0
    return mail.send(subject, body, to)


def notify_recipients(sign_request, recipients) -> list:
    """"Please sign" — the one email that has to be trusted by a stranger.

    Returns the recipients that were **actually** mailed, so the audit trail
    records what happened rather than what was attempted.
    """
    sender = _sender_name(sign_request)
    notified: list = []
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
        if not _send(f"{sender} would like you to {action}: {sign_request.title}",
                     "\n".join(lines), [recipient.email]):
            # Suppressed or undeliverable. Leaving `last_notified_at` unset is
            # what lets the sender see "not notified" instead of waiting on a
            # signature nobody was ever asked for.
            notified.append((recipient, False))
            continue
        recipient.last_notified_at = timezone.now()
        recipient.status = recipient.Status.NOTIFIED \
            if recipient.status == recipient.Status.PENDING else recipient.status
        recipient.save(update_fields=["last_notified_at", "status"])
        notified.append((recipient, True))
    return [r for r, ok in notified if ok]


def notify_reminder(sign_request, recipient) -> bool:
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
    if not _send(f"Reminder: {sign_request.title}", body, [recipient.email]):
        # Do not burn the once-a-day nudge on a message that never went.
        return False
    recipient.last_notified_at = timezone.now()
    recipient.save(update_fields=["last_notified_at"])
    return True


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


def notify_paused_for_abuse(sign_request, reports: int) -> None:
    """The owner is told, in plain words, by people rather than by a robot."""
    body = "\n".join([
        f'"{sign_request.title}" has been paused.',
        "",
        f"{reports} of the people you sent it to told us they did not expect "
        "it. Nobody else will be asked to sign, and the links no longer work.",
        "",
        "If that is a surprise, check the addresses you entered — a typo sends "
        "somebody's contract to a stranger. If you believe this is a mistake, "
        f"reply to {settings.ABUSE_CONTACT_EMAIL}.",
        "",
        f"Envelope {sign_request.envelope_code}.",
    ])
    mail.send(f"Paused: {sign_request.title}", body, [sign_request.owner.email],
              transactional=True)


def notify_expired(sign_request, pending) -> None:
    body = "\n".join([
        f"\"{sign_request.title}\" has expired without being completed.",
        "",
        f"Envelope {sign_request.envelope_code}.",
        "Nobody can sign it now. Send it again if it is still needed.",
    ])
    _send(f"Expired: {sign_request.title}", body,
          list({sign_request.owner.email, *[r.email for r in pending]}))
