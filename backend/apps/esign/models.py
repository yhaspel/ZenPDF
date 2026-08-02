"""E-signature models (01-architecture.md §9, phase-08).

Five tables and one property that matters more than the rest: `AuditEvent` is a
**hash chain**. Each event stores the hash of the one before it, so the log can
be recomputed end to end and any edit — a changed IP, a deleted row, a
reordered pair — breaks every hash after it. That is the difference between a
list of things we say happened and evidence that they did, and it is what the
certificate of completion is printed from.

What this is *not*: a qualified electronic signature. We implement a simple
electronic signature (SES) with a platform seal, which is what Documenso and
DocuSeal do, and the product copy says exactly that (00-research §2).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import uuid

from django.conf import settings
from django.db import models, transaction
from django.utils import timezone

# 32 random bytes, urlsafe-encoded — 43 characters, and the only thing standing
# between the internet and one recipient's view of one document.
TOKEN_BYTES = 32

ENVELOPE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no I/O/0/1


def new_token() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


def new_envelope_code() -> str:
    """`ZEN-8F3KQ2` — short enough to read down a phone line, and stamped on
    every page of the completed document."""
    body = "".join(secrets.choice(ENVELOPE_ALPHABET) for _ in range(6))
    return f"ZEN-{body}"


class SavedSignature(models.Model):
    """A signature a *user* keeps for reuse.

    Account-only by design (§21.3): a guest draws one and it lives in the
    browser for the session. Saving it means storing an image of somebody's
    signature, which needs an account to belong to.
    """

    class Kind(models.TextChoices):
        SIGNATURE = "signature"
        INITIALS = "initials"

    class Method(models.TextChoices):
        DRAW = "draw"
        TYPE = "type"
        UPLOAD = "upload"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey("users.User", on_delete=models.CASCADE,
                            related_name="signatures")
    kind = models.CharField(max_length=16, choices=Kind.choices, default=Kind.SIGNATURE)
    method = models.CharField(max_length=16, choices=Method.choices, default=Method.DRAW)
    storage_key = models.CharField(max_length=500)
    typed_text = models.CharField(max_length=100, blank=True)
    font = models.CharField(max_length=50, blank=True)
    is_default = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("-is_default", "-created_at")

    def __str__(self) -> str:  # pragma: no cover - admin convenience
        return f"{self.kind} ({self.method})"


class SignRequest(models.Model):
    class Status(models.TextChoices):
        DRAFT = "draft"
        SENT = "sent"
        COMPLETED = "completed"
        DECLINED = "declined"
        EXPIRED = "expired"
        CANCELED = "canceled"
        # Paused by reports, not by the owner — kept distinct so the owner's
        # notification and the audit trail can say which it was (§9B).
        CANCELED_BY_ABUSE = "canceled_by_abuse"

    OPEN_STATUSES = {Status.DRAFT, Status.SENT}
    # Finished *badly*: nothing more can happen and the links stop working.
    # `completed` is deliberately not here — a recipient must still be able to
    # open their own finished envelope and download their copy, which is the
    # ESIGN retention path.
    CLOSED_STATUSES = {Status.EXPIRED, Status.CANCELED, Status.CANCELED_BY_ABUSE,
                       Status.DECLINED}

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # Nullable, and `SET_NULL` rather than `CASCADE`: a completed envelope is
    # the *counterparty's* evidence of an agreement, and it has to survive the
    # sender closing their account (§10.1). What does not survive is the link
    # to the account — see `users/privacy.py`.
    owner = models.ForeignKey("users.User", on_delete=models.SET_NULL,
                              null=True, blank=True,
                              related_name="sign_requests")
    document = models.ForeignKey("documents.Document", on_delete=models.SET_NULL,
                                 null=True, blank=True,
                                 related_name="sign_requests")
    # Who sent it, as text, captured at send. The certificate and the public
    # ceremony read *this*, not the FK: a record that cannot be printed once
    # the account is gone is not a record.
    sender_email = models.EmailField(blank=True)
    sender_name = models.CharField(max_length=200, blank=True)

    @property
    def sender_address(self) -> str:
        """The snapshot, falling back to the account while one exists — a draft
        has not been sent yet, so it has no snapshot."""
        return self.sender_email or getattr(self.owner, "email", "")

    @property
    def sender_display_name(self) -> str:
        name = (self.sender_name
                or getattr(self.owner, "display_name", "") or "").strip()
        return name
    # Frozen at send: later edits to the document must not change what a
    # recipient is asked to sign, and must not change what was signed.
    source_version = models.ForeignKey("documents.DocumentVersion",
                                       on_delete=models.PROTECT, null=True, blank=True,
                                       related_name="sign_requests")
    title = models.CharField(max_length=255)
    message = models.TextField(blank=True)
    status = models.CharField(max_length=20, choices=Status.choices,
                              default=Status.DRAFT)
    envelope_code = models.CharField(max_length=16, unique=True, default=new_envelope_code)
    expires_at = models.DateTimeField(null=True, blank=True)
    reminder_every_days = models.PositiveSmallIntegerField(default=3)
    sent_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    final_key = models.CharField(max_length=500, blank=True)
    certificate_key = models.CharField(max_length=500, blank=True)
    final_sha256 = models.CharField(max_length=64, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=["owner", "status"]),
            # The sender's own list has no status filter — the view sets no
            # `filterset_fields` and the SPA sends none — so `(owner, status)`
            # gives the owner prefix and nothing for `ORDER BY created_at
            # DESC`. At 102k documents that was 612 buffers: 200 primary-key
            # probes into `documents_document` for the `select_related`, then a
            # top-N heapsort, to return 50 rows. 155 and no sort with this.
            models.Index(fields=["owner", "-created_at"], name="sign_owner_recent"),
        ]

    def __str__(self) -> str:  # pragma: no cover - admin convenience
        return f"{self.envelope_code} — {self.title}"

    @property
    def is_terminal(self) -> bool:
        return self.status not in self.OPEN_STATUSES

    @property
    def is_closed(self) -> bool:
        """Finished badly — the signing links are dead."""
        return self.status in self.CLOSED_STATUSES

    def acting_recipients(self):
        """The ones whose completion the request waits for.

        `cc` never acts — it receives the result. `viewer` does: the decision in
        phase-08's test list is that a viewer must open the document, and
        opening *is* completion for that role.
        """
        return self.recipients.exclude(role=Recipient.Role.CC)


class Recipient(models.Model):
    class Role(models.TextChoices):
        SIGNER = "signer"
        APPROVER = "approver"
        VIEWER = "viewer"
        CC = "cc"

    class Status(models.TextChoices):
        PENDING = "pending"
        NOTIFIED = "notified"
        VIEWED = "viewed"
        CONSENTED = "consented"
        COMPLETED = "completed"
        DECLINED = "declined"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    sign_request = models.ForeignKey(SignRequest, on_delete=models.CASCADE,
                                     related_name="recipients")
    email = models.EmailField()
    name = models.CharField(max_length=200, blank=True)
    role = models.CharField(max_length=16, choices=Role.choices, default=Role.SIGNER)
    # Same order ⇒ parallel group; groups proceed in ascending order.
    order = models.PositiveSmallIntegerField(default=1)
    status = models.CharField(max_length=16, choices=Status.choices,
                              default=Status.PENDING)
    token = models.CharField(max_length=64, unique=True, default=new_token,
                             db_index=True)
    consent_at = models.DateTimeField(null=True, blank=True)
    consent_ip = models.GenericIPAddressField(null=True, blank=True)
    consent_user_agent = models.CharField(max_length=500, blank=True)
    decline_reason = models.TextField(blank=True)
    last_notified_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("order", "created_at")

    def __str__(self) -> str:  # pragma: no cover - admin convenience
        return f"{self.email} ({self.role})"

    @property
    def acts(self) -> bool:
        """Whether the request waits for this recipient."""
        return self.role != self.Role.CC

    @property
    def needs_consent(self) -> bool:
        """A viewer is not signing anything, so ESIGN consent does not apply.

        Everyone who *acts on* the document — signs or approves — consents
        first, and nothing else is accepted until they have.
        """
        return self.role in {self.Role.SIGNER, self.Role.APPROVER}


class SignField(models.Model):
    class Type(models.TextChoices):
        SIGNATURE = "signature"
        INITIALS = "initials"
        DATE_SIGNED = "date_signed"
        TEXT = "text"
        CHECKBOX = "checkbox"

    IMAGE_TYPES = {Type.SIGNATURE, Type.INITIALS}

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    sign_request = models.ForeignKey(SignRequest, on_delete=models.CASCADE,
                                     related_name="fields")
    recipient = models.ForeignKey(Recipient, on_delete=models.CASCADE,
                                  related_name="fields")
    page = models.PositiveIntegerField(default=0)
    # §8 normalized visual space: 0..1 of the displayed page, origin top-left.
    x = models.FloatField()
    y = models.FloatField()
    w = models.FloatField()
    h = models.FloatField()
    type = models.CharField(max_length=16, choices=Type.choices, default=Type.SIGNATURE)
    required = models.BooleanField(default=True)
    label = models.CharField(max_length=100, blank=True)
    value = models.TextField(blank=True)
    # Signature/initials images live in object storage, not in `value`.
    image_key = models.CharField(max_length=500, blank=True)
    filled_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("page", "y", "x")

    @property
    def is_filled(self) -> bool:
        if self.type in self.IMAGE_TYPES:
            return bool(self.image_key)
        if self.type == self.Type.DATE_SIGNED:
            return True  # written by the system at completion, never by hand
        if self.type == self.Type.CHECKBOX:
            return self.value in {"true", "false"}
        return bool(self.value)

    def rect(self) -> dict:
        return {"x": self.x, "y": self.y, "w": self.w, "h": self.h}


class AuditEvent(models.Model):
    """Append-only, hash-chained (§9).

    No update or delete path exists in the codebase — `save()` refuses a second
    write, because an audit trail that can be edited is a claim rather than
    evidence. The chain is what the certificate prints and what
    `verify_chain()` recomputes.
    """

    class Type(models.TextChoices):
        CREATED = "created"
        SENT = "sent"
        OPENED = "opened"
        CONSENTED = "consented"
        FIELD_FILLED = "field_filled"
        SIGNED = "signed"
        APPROVED = "approved"
        DECLINED = "declined"
        REMINDER_SENT = "reminder_sent"
        EXPIRED = "expired"
        CANCELED = "canceled"
        COMPLETED = "completed"
        SEAL_APPLIED = "seal_applied"
        DOWNLOADED = "downloaded"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    sign_request = models.ForeignKey(SignRequest, on_delete=models.CASCADE,
                                     related_name="audit_events")
    recipient = models.ForeignKey(Recipient, on_delete=models.SET_NULL, null=True,
                                  blank=True, related_name="audit_events")
    type = models.CharField(max_length=32, choices=Type.choices)
    created_at = models.DateTimeField(default=timezone.now)
    ip = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=500, blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    prev_hash = models.CharField(max_length=64, blank=True)
    event_hash = models.CharField(max_length=64, blank=True)

    class Meta:
        ordering = ("created_at", "id")
        # Every append reads the tail of this chain, and the certificate reads
        # all of it in order — both are this index (§10.2).
        indexes = [models.Index(fields=["sign_request", "created_at"],
                                name="audit_request_created")]

    def payload(self) -> dict:
        """Exactly what the hash covers. Canonical JSON: sorted keys, no
        whitespace, so the same event always hashes the same way."""
        return {
            "type": self.type,
            "created_at": self.created_at.isoformat(),
            "recipient_id": str(self.recipient_id) if self.recipient_id else None,
            "ip": self.ip,
            "user_agent": self.user_agent,
            "metadata": self.metadata or {},
        }

    def compute_hash(self, prev_hash: str) -> str:
        """HMAC-SHA256 under `SECRET_KEY`, not a bare digest.

        A plain SHA-256 chain is only self-*consistent*: anybody who can write
        to the database can edit an event and recompute every hash after it, and
        every check we offer would still say "the chain verifies" — which is not
        what the disclosure promises the signer. The key lives in the
        environment, so rewriting history now takes the application's secret as
        well as its database.
        """
        canonical = json.dumps(self.payload(), sort_keys=True, separators=(",", ":"))
        return hmac.new(settings.SECRET_KEY.encode(),
                        (prev_hash + canonical).encode(),
                        hashlib.sha256).hexdigest()

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise ValueError(
                "Audit events are append-only — a trail that can be edited is a "
                "claim, not evidence."
            )
        # The parent row is locked while the tail is read and the new hash
        # computed. Without it two concurrent writers — two recipients in a
        # parallel group, or two clicks on Download — read the same tail, both
        # write the same `prev_hash`, and the chain **forks**. It is append-only,
        # so there is no repair: `verify_chain` would report broken for ever on
        # a request where nothing wrong actually happened.
        with transaction.atomic():
            SignRequest.objects.select_for_update().filter(
                pk=self.sign_request_id).first()
            previous = (AuditEvent.objects
                        .filter(sign_request_id=self.sign_request_id)
                        .order_by("created_at", "id").last())
            self.prev_hash = previous.event_hash if previous else ""
            self.event_hash = self.compute_hash(self.prev_hash)
            return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValueError("Audit events are append-only.")


class AbuseReport(models.Model):
    """Somebody said "I did not ask for this" (§9B).

    Reported *per signing link*, because the person who can tell us is the
    recipient, and the thing they can identify is the request they were sent.
    Three distinct reporters pauses the request — one angry recipient should
    not be able to stop a legitimate contract, and three is a signal.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    sign_request = models.ForeignKey(SignRequest, on_delete=models.CASCADE,
                                     related_name="abuse_reports")
    recipient = models.ForeignKey(Recipient, on_delete=models.SET_NULL, null=True,
                                  blank=True, related_name="abuse_reports")
    reason = models.TextField(blank=True)
    ip = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=500, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("-created_at",)

    def __str__(self) -> str:  # pragma: no cover - admin convenience
        return f"report on {self.sign_request_id}"


def record(sign_request, event_type, *, recipient=None, request=None, **metadata):
    """Append one event. The only way anything writes to the chain."""
    ip, agent = None, ""
    if request is not None:
        ip = client_ip(request)
        agent = (request.META.get("HTTP_USER_AGENT") or "")[:500]
    return AuditEvent.objects.create(
        sign_request=sign_request, recipient=recipient, type=event_type,
        ip=ip, user_agent=agent, metadata=metadata or {},
    )


def client_ip(request) -> str | None:
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR")


def verify_chain(sign_request) -> dict:
    """Recompute the chain: `{intact, count, broken_at, head}`.

    A tampered row, a deleted one, or two swapped: each changes a hash and
    every hash after it, which is the property the certificate relies on.
    """
    prev = ""
    events = list(sign_request.audit_events.all())
    for event in events:
        if event.prev_hash != prev or event.event_hash != event.compute_hash(prev):
            return {"intact": False, "count": len(events),
                    "broken_at": str(event.id), "head": prev}
        prev = event.event_hash
    return {"intact": True, "count": len(events), "broken_at": None, "head": prev}
