"""The routing engine (phase-08 §8B).

Who gets asked next, and when is a request finished. Small enough to read in
one sitting, which is deliberate: every rule here is visible to a signer as
"why haven't I been emailed yet", and a subtle bug is one people cannot
report because they cannot see it.

The model: recipients carry an `order`. Same order ⇒ **parallel group**;
groups run in ascending order. A group is done when every acting recipient in
it has completed. `cc` never acts — it receives the result. A `viewer` does
act: opening the document *is* completion for that role (phase-08's own
decision in its test list).
"""
from __future__ import annotations

from django.utils import timezone

from .models import Recipient, SignRequest, record


def acting(sign_request) -> list[Recipient]:
    return [r for r in sign_request.recipients.all() if r.acts]


def groups(sign_request) -> list[int]:
    """Ascending distinct orders that still contain someone who must act."""
    return sorted({r.order for r in acting(sign_request)})


def current_group(sign_request) -> int | None:
    """The lowest group with an outstanding acting recipient, or None if done."""
    for order in groups(sign_request):
        members = [r for r in acting(sign_request) if r.order == order]
        if any(r.status != Recipient.Status.COMPLETED for r in members):
            return order
    return None


def is_recipients_turn(recipient) -> bool:
    """Whether this recipient may act *now*.

    A later signer following a link they were forwarded early gets a friendly
    wait page rather than a document they are not yet supposed to change.
    """
    if not recipient.acts:
        return False
    active = current_group(recipient.sign_request)
    return active is not None and recipient.order <= active


def everyone_done(sign_request) -> bool:
    people = acting(sign_request)
    return bool(people) and all(r.status == Recipient.Status.COMPLETED
                                for r in people)


def next_to_notify(sign_request) -> list[Recipient]:
    """Recipients in the current group who have not been emailed yet."""
    order = current_group(sign_request)
    if order is None:
        return []
    return [r for r in acting(sign_request)
            if r.order == order and r.status == Recipient.Status.PENDING]


def advance(sign_request, *, request=None) -> str:
    """Called after a recipient completes. Returns what happened.

    Three outcomes, and the caller does the side effects: `"notified"` (the
    next group has been emailed), `"completed"` (everyone is done — finalize),
    or `"waiting"` (this group still has people in it).
    """
    from .emails import notify_recipients

    if everyone_done(sign_request):
        return "completed"
    pending = next_to_notify(sign_request)
    if pending:
        notify_recipients(sign_request, pending)
        record(sign_request, "sent", request=request,
               to=[r.email for r in pending], stage="routing")
        return "notified"
    return "waiting"


def complete_recipient(recipient, *, request=None, event="signed", **metadata):
    """Mark one recipient done and write the audit event.

    Idempotent on purpose: a double-tap on "Finish" in a flaky mobile network
    must not write two `signed` events into a chain that is meant to be
    evidence.
    """
    if recipient.status == Recipient.Status.COMPLETED:
        return False
    recipient.status = Recipient.Status.COMPLETED
    recipient.completed_at = timezone.now()
    recipient.save(update_fields=["status", "completed_at"])
    record(recipient.sign_request, event, recipient=recipient, request=request,
           role=recipient.role, **metadata)
    return True


def decline(recipient, reason: str, *, request=None) -> None:
    """One decline ends the request for everybody.

    The alternative — carrying on and collecting the rest — produces a document
    that looks signed and is not, which is worse than a stopped process.
    """
    from .emails import notify_declined

    recipient.status = Recipient.Status.DECLINED
    recipient.decline_reason = (reason or "")[:2000]
    recipient.save(update_fields=["status", "decline_reason"])

    sign_request = recipient.sign_request
    sign_request.status = SignRequest.Status.DECLINED
    sign_request.save(update_fields=["status"])
    record(sign_request, "declined", recipient=recipient, request=request,
           reason=recipient.decline_reason)
    notify_declined(sign_request, recipient)
