"""E-signature API (phase-08).

Three audiences, three access rules, and the split is normative (§21.3):

* **Saved signatures and sign requests** — account-only. Sending email in
  somebody's name needs an identified sender, both for ESIGN attribution and
  because a guest-triggerable outbound path is a spam relay pointed at our own
  domain reputation.
* **The ceremony** (`/api/public/sign/{token}/`) — no auth at all. The token
  *is* the capability: 32 random bytes, one recipient, one request.
* **`/verify`** — public and unauthenticated, because the person who needs it
  most is the one who was sent a PDF by a stranger.

Self-signing is not here at all: it is an operation on a document
(`self_sign`, §10), and it is guest-accessible.
"""
from __future__ import annotations

from django.conf import settings
from django.http import HttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import generics, status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.core import limits as L
from apps.core.assets import ImageRejected, asset_key, store_image
from apps.core.exceptions import (
    ConsentRequired,
    TokenExpired,
    TokenInvalid,
    ValidationFailed,
)
from apps.core.permissions import IsAccount
from apps.core.principals import owned_by
from apps.core.throttling import PublicSignThrottle
from apps.documents.models import Document
from apps.pdf_engine.engine import seal as SEAL
from apps.pdf_engine.engine import signatures as SG
from apps.pdf_engine.exceptions import EngineError
from apps.pdf_engine.storage import get_storage

from . import emails, routing
from .legal import DISCLOSURE, VERSION, consent_metadata
from .models import (
    Recipient,
    SavedSignature,
    SignField,
    SignRequest,
    record,
    verify_chain,
)
from .serializers import (
    AuditEventSerializer,
    FieldWriteSerializer,
    PublicFieldSerializer,
    RecipientWriteSerializer,
    SavedSignatureSerializer,
    SignRequestCreateSerializer,
    SignRequestSerializer,
)
from .tasks import finalize_sign_request

MAX_RECIPIENTS = 25
MAX_FIELDS = 200


# --------------------------------------------------------------------------- #
# 8A — saved signatures (account-only; a guest keeps one in the browser)
# --------------------------------------------------------------------------- #
class SignatureListView(generics.ListCreateAPIView):
    serializer_class = SavedSignatureSerializer
    permission_classes = [IsAccount]
    pagination_class = None
    account_required_message = (
        "Create a free account to keep a signature for reuse. You can still "
        "sign a document right now without one."
    )

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return SavedSignature.objects.none()
        return SavedSignature.objects.filter(user=self.request.user)

    @extend_schema(request=OpenApiTypes.OBJECT, tags=["esign"])
    def post(self, request, *args, **kwargs):
        data = request.data
        method = str(data.get("method") or "draw")
        kind = str(data.get("kind") or "signature")
        if kind not in dict(SavedSignature.Kind.choices):
            raise ValidationFailed("kind must be 'signature' or 'initials'.")

        try:
            png = _signature_png(request, method, data)
        except EngineError as exc:
            raise ValidationFailed(exc.message) from exc
        except ImageRejected as exc:
            raise ValidationFailed(str(exc)) from exc

        # Stored in the account's own asset prefix (§13), so the same quota,
        # the same key derivation and the same purge apply as to every other
        # uploaded image.
        asset = store_image(request.user, png)
        row = SavedSignature.objects.create(
            user=request.user, kind=kind, method=method,
            storage_key=asset_key(request.user, asset["ref"]),
            typed_text=str(data.get("text") or "")[:100],
            font=str(data.get("font") or "")[:50],
            is_default=bool(data.get("is_default")),
        )
        if row.is_default:
            SavedSignature.objects.filter(user=request.user, kind=kind).exclude(
                pk=row.pk).update(is_default=False)
        return Response(SavedSignatureSerializer(row).data,
                        status=status.HTTP_201_CREATED)


def _signature_png(request, method: str, data) -> bytes:
    """Turn whatever the client sent into a trimmed, transparent PNG."""
    if method == "type":
        return SG.render_typed(str(data.get("text") or ""),
                               str(data.get("font") or "caveat"))
    upload = request.FILES.get("file")
    if upload is not None:
        # Checked *before* the bytes are decoded. `store_image` applies the
        # tier cap on the way out, which is too late: `remove_background` runs
        # a per-pixel pass in the API process, and a 1.5 MB 40000×40000 PNG is
        # minutes of CPU and gigabytes of memory before any cap is consulted.
        tier = L.for_principal(request.user)
        if upload.size > tier.max_image_upload_bytes:
            raise ValidationFailed(
                f"A signature image must be "
                f"{tier.max_image_upload_bytes // (1024 * 1024)} MB or smaller."
            )
    raw = upload.read() if upload else _decode_data_url(data.get("image"))
    if not raw:
        raise ValidationFailed("No signature image was sent.")
    if len(raw) > 12 * 1024 * 1024:
        raise ValidationFailed("That signature image is too large.")
    # One normalizer for every route in: a photograph has no alpha channel, so
    # trimming alone left the *paper* to be stamped onto the document.
    return SG.normalize_signature(raw)


def _decode_data_url(value) -> bytes:
    import base64

    text = str(value or "")
    if "," in text and text.startswith("data:"):
        text = text.split(",", 1)[1]
    if not text:
        return b""
    try:
        return base64.b64decode(text, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValidationFailed("That signature image could not be read.") from exc


class SignatureDetailView(generics.RetrieveDestroyAPIView):
    serializer_class = SavedSignatureSerializer
    permission_classes = [IsAccount]

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return SavedSignature.objects.none()
        return SavedSignature.objects.filter(user=self.request.user)

    def perform_destroy(self, instance):
        """Take the blob and the quota with it.

        Deleting the row alone left the PNG in storage for ever and never
        credited the bytes back — the user sees the signature gone and their
        storage figure unchanged.
        """
        from apps.core import limits as L

        storage = get_storage()
        try:
            size = len(storage.get_bytes(instance.storage_key))
            storage.delete(instance.storage_key)
            L.bump_storage(instance.user, -size)
        except Exception:  # noqa: BLE001 - a missing blob must not block delete
            pass
        instance.delete()


class SignatureImageView(APIView):
    """The PNG itself, for the picker."""

    permission_classes = [IsAccount]

    @extend_schema(responses=OpenApiTypes.BINARY, tags=["esign"])
    def get(self, request, pk):
        row = get_object_or_404(SavedSignature, pk=pk, user=request.user)
        data = get_storage().get_bytes(row.storage_key)
        response = HttpResponse(data, content_type="image/png")
        response["Cache-Control"] = "private, max-age=86400"
        return response


class SignatureRenderView(APIView):
    """`POST /api/signatures/render/` — a preview PNG, for **anyone**.

    The typed-signature fonts live on the server, so a guest choosing "type my
    name" needs this to see what they are about to place. It stores nothing: no
    row, no asset, no principal — which is what keeps the guest path free of an
    account (§21.3).
    """

    permission_classes = [AllowAny]
    throttle_scope = "image_upload"

    @extend_schema(request=OpenApiTypes.OBJECT, responses=OpenApiTypes.BINARY,
                   tags=["esign"])
    def post(self, request):
        try:
            png = SG.render_typed(str(request.data.get("text") or ""),
                                  str(request.data.get("font") or "caveat"))
        except EngineError as exc:
            raise ValidationFailed(exc.message) from exc
        return HttpResponse(png, content_type="image/png")

    def get_throttles(self):
        """The scoped rate **in addition to** the defaults.

        `throttle_scope` on its own does nothing: the project's
        `DEFAULT_THROTTLE_CLASSES` contains no `ScopedRateThrottle`, so the
        declared 60/hour was inert and this endpoint ran on the 30/min anon
        bucket instead (same fix, and the same reason, as `core/views.py`).
        """
        return [*super().get_throttles(), ScopedRateThrottle()]



# --------------------------------------------------------------------------- #
# 8B — sign requests (account-only)
# --------------------------------------------------------------------------- #
class SignRequestListView(generics.ListAPIView):
    serializer_class = SignRequestSerializer
    permission_classes = [IsAccount]
    account_required_message = (
        "Create a free account to send a document for signature. Signing one "
        "yourself needs no account."
    )

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return SignRequest.objects.none()
        return (SignRequest.objects.filter(owner=self.request.user)
                .select_related("document").prefetch_related("recipients", "fields"))

    @extend_schema(request=SignRequestCreateSerializer, tags=["esign"])
    def post(self, request):
        serializer = SignRequestCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        # Through the choke point (§21.2), like every other ownership check —
        # `owner=` here would read as `owner_id IS NULL` for a guest and match
        # any guest's document.
        document = get_object_or_404(
            owned_by(Document.objects.filter(trashed_at__isnull=True),
                     request.user),
            pk=data["document"],
        )
        if document.is_encrypted:
            raise ValidationFailed(
                "This document is password-protected. Remove the password "
                "before sending it for signature — the people you send it to "
                "will not have it."
            )
        # Checked at *draft* time as well as at send: a builder that lets
        # somebody lay out fields for twenty minutes and then refuses is a
        # worse experience than one that says so at the start (§16).
        L.enforce_sign_requests(request.user)

        days = data.get("expires_in_days", 30)
        sign_request = SignRequest.objects.create(
            owner=request.user, document=document,
            title=(data.get("title") or document.title)[:255],
            message=data.get("message", ""),
            expires_at=timezone.now() + timezone.timedelta(days=days),
            reminder_every_days=data.get("reminder_every_days", 3),
        )
        record(sign_request, "created", request=request, document=str(document.id))
        return Response(SignRequestSerializer(sign_request).data,
                        status=status.HTTP_201_CREATED)


class SignRequestDetailView(APIView):
    permission_classes = [IsAccount]
    serializer_class = SignRequestSerializer

    def _get(self, request, pk) -> SignRequest:
        return get_object_or_404(
            SignRequest.objects.prefetch_related("recipients", "fields"),
            pk=pk, owner=request.user,
        )

    @extend_schema(responses=SignRequestSerializer, tags=["esign"])
    def get(self, request, pk):
        return Response(SignRequestSerializer(self._get(request, pk)).data)

    @extend_schema(request=OpenApiTypes.OBJECT, responses=SignRequestSerializer,
                   tags=["esign"])
    def patch(self, request, pk):
        """Recipients and fields, while the request is still a draft.

        Editable only in `draft` — once it is sent, the people holding links
        have been told what they are signing, and changing it underneath them
        is the one thing a signing product must never do.
        """
        sign_request = self._get(request, pk)
        if sign_request.status != SignRequest.Status.DRAFT:
            raise ValidationFailed(
                "This request has already been sent, so it cannot be changed. "
                "Cancel it and send a new one."
            )

        data = request.data
        for key in ("title", "message"):
            if key in data:
                setattr(sign_request, key, str(data[key])[:5000])
        if "expires_in_days" in data:
            sign_request.expires_at = timezone.now() + timezone.timedelta(
                days=_bounded(data["expires_in_days"], 1, 365, "expires_in_days"))
        if "reminder_every_days" in data:
            sign_request.reminder_every_days = _bounded(
                data["reminder_every_days"], 0, 90, "reminder_every_days")
        sign_request.save()

        if "recipients" in data:
            _replace_recipients(sign_request, data["recipients"])
        if "fields" in data:
            _replace_fields(sign_request, data["fields"])
        return Response(SignRequestSerializer(
            self._get(request, pk)).data)

    @extend_schema(request=None, responses={204: None}, tags=["esign"])
    def delete(self, request, pk):
        sign_request = self._get(request, pk)
        if sign_request.status != SignRequest.Status.DRAFT:
            raise ValidationFailed("Only a draft can be deleted. Cancel it instead.")
        sign_request.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


def _bounded(value, low: int, high: int, name: str) -> int:
    """An int in range, or a 400 — `int("soon")` was a 500."""
    try:
        return max(low, min(high, int(value)))
    except (TypeError, ValueError) as exc:
        raise ValidationFailed(f"{name} must be a whole number.") from exc


def _replace_recipients(sign_request, payload) -> None:
    if not isinstance(payload, list) or len(payload) > MAX_RECIPIENTS:
        raise ValidationFailed(f"Between 1 and {MAX_RECIPIENTS} recipients.")
    rows = []
    for item in payload:
        serializer = RecipientWriteSerializer(data=item)
        serializer.is_valid(raise_exception=True)
        rows.append(serializer.validated_data)
    # Fields hang off recipients, so replacing the list drops the layout with
    # it — the builder re-sends both, and a field bound to a recipient who is
    # no longer on the request is worse than an empty page.
    sign_request.recipients.all().delete()
    for row in rows:
        Recipient.objects.create(sign_request=sign_request, **row)


def _replace_fields(sign_request, payload) -> None:
    if not isinstance(payload, list) or len(payload) > MAX_FIELDS:
        raise ValidationFailed(f"At most {MAX_FIELDS} fields.")
    by_id = {str(r.id): r for r in sign_request.recipients.all()}
    rows = []
    for item in payload:
        serializer = FieldWriteSerializer(data=item)
        serializer.is_valid(raise_exception=True)
        values = serializer.validated_data
        recipient = by_id.get(str(values.pop("recipient_id")))
        if recipient is None:
            raise ValidationFailed("A field is bound to somebody who is not a "
                                   "recipient of this request.")
        rows.append((recipient, values))
    sign_request.fields.all().delete()
    for recipient, values in rows:
        SignField.objects.create(sign_request=sign_request, recipient=recipient,
                                 **values)


class SignRequestSendView(APIView):
    permission_classes = [IsAccount]

    @extend_schema(request=None, responses=SignRequestSerializer, tags=["esign"])
    def post(self, request, pk):
        sign_request = get_object_or_404(SignRequest, pk=pk, owner=request.user)
        if sign_request.status != SignRequest.Status.DRAFT:
            raise ValidationFailed("This request has already been sent.")

        recipients = list(sign_request.recipients.all())
        signers = [r for r in recipients if r.role == Recipient.Role.SIGNER]
        if not signers:
            raise ValidationFailed("Add at least one signer.")
        for recipient in signers:
            if not recipient.fields.exists():
                raise ValidationFailed(
                    f"{recipient.email} has nothing to sign — place at least "
                    "one field for them."
                )
        version = sign_request.document.current_version
        if version is None:
            raise ValidationFailed("That document has no content to send.")

        L.enforce_sign_requests(request.user)

        # Frozen here, deliberately: everything after this point reads
        # `source_version`, so editing the document tomorrow cannot change what
        # somebody was asked to sign yesterday.
        sign_request.source_version = version
        sign_request.status = SignRequest.Status.SENT
        sign_request.sent_at = timezone.now()
        sign_request.save(update_fields=["source_version", "status", "sent_at"])

        first = routing.next_to_notify(sign_request)
        emails.notify_recipients(sign_request, first)
        record(sign_request, "sent", request=request,
               to=[r.email for r in first], version=version.seq)
        L.record_sign_request(request.user)
        return Response(SignRequestSerializer(sign_request).data)


class SignRequestCancelView(APIView):
    permission_classes = [IsAccount]

    @extend_schema(request=None, responses=SignRequestSerializer, tags=["esign"])
    def post(self, request, pk):
        sign_request = get_object_or_404(SignRequest, pk=pk, owner=request.user)
        if sign_request.is_terminal:
            raise ValidationFailed("This request has already finished.")
        sign_request.status = SignRequest.Status.CANCELED
        sign_request.save(update_fields=["status"])
        record(sign_request, "canceled", request=request)
        return Response(SignRequestSerializer(sign_request).data)


class SignRequestRemindView(APIView):
    permission_classes = [IsAccount]

    @extend_schema(request=None, responses=OpenApiTypes.OBJECT, tags=["esign"])
    def post(self, request, pk):
        sign_request = get_object_or_404(SignRequest, pk=pk, owner=request.user)
        if sign_request.status != SignRequest.Status.SENT:
            raise ValidationFailed("Only a sent request can be nudged.")
        order = routing.current_group(sign_request)
        pending = [r for r in sign_request.recipients.filter(order=order)
                   if r.acts and r.status != Recipient.Status.COMPLETED]
        now = timezone.now()
        # One nudge a day, per recipient: a reminder button that can be held
        # down is a way to make somebody's inbox unusable from our domain.
        sent = []
        for recipient in pending:
            if recipient.last_notified_at and \
                    (now - recipient.last_notified_at).total_seconds() < 86400:
                continue
            emails.notify_reminder(sign_request, recipient)
            record(sign_request, "reminder_sent", recipient=recipient,
                   request=request, manual=True)
            sent.append(recipient.email)
        return Response({"reminded": sent,
                         "skipped": [r.email for r in pending
                                     if r.email not in sent]})


class SignRequestAuditView(APIView):
    permission_classes = [IsAccount]

    @extend_schema(responses=OpenApiTypes.OBJECT, tags=["esign"])
    def get(self, request, pk):
        sign_request = get_object_or_404(SignRequest, pk=pk, owner=request.user)
        events = AuditEventSerializer(sign_request.audit_events.all(),
                                      many=True).data
        return Response({"events": events, "chain": verify_chain(sign_request)})


class SignRequestDownloadView(APIView):
    """`final` or `certificate`, for the owner."""

    permission_classes = [IsAccount]

    @extend_schema(responses=OpenApiTypes.BINARY, tags=["esign"])
    def get(self, request, pk, what):
        sign_request = get_object_or_404(SignRequest, pk=pk, owner=request.user)
        return _stream_artifact(sign_request, what, request=request)


def _stream_artifact(sign_request, what: str, *, request=None, recipient=None):
    key = (sign_request.final_key if what == "final"
           else sign_request.certificate_key)
    if not key:
        raise TokenExpired("That file is not ready yet.")
    data = get_storage().get_bytes(key)
    record(sign_request, "downloaded", recipient=recipient, request=request,
           what=what)
    filename = (f"{sign_request.title}.pdf" if what == "final"
                else f"Certificate {sign_request.envelope_code}.pdf")
    response = HttpResponse(data, content_type="application/pdf")
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    return response


# --------------------------------------------------------------------------- #
# The public ceremony — no auth, the token is the capability
# --------------------------------------------------------------------------- #
class PublicSignBase(APIView):
    permission_classes = [AllowAny]
    authentication_classes: list = []
    throttle_classes = [PublicSignThrottle]

    def recipient(self, token: str) -> Recipient:
        recipient = (Recipient.objects
                     .select_related("sign_request", "sign_request__owner",
                                     "sign_request__source_version")
                     .filter(token=token).first())
        if recipient is None:
            # 401 rather than 404: the token is a credential, and "no such
            # token" is the honest answer to a bad one.
            raise TokenInvalid("This signing link is not valid.")
        sign_request = recipient.sign_request
        if sign_request.status in {SignRequest.Status.EXPIRED,
                                   SignRequest.Status.CANCELED,
                                   SignRequest.Status.DECLINED}:
            raise TokenExpired(f"This request was {sign_request.status}.")
        if sign_request.status == SignRequest.Status.DRAFT:
            raise TokenInvalid("This request has not been sent yet.")
        if sign_request.expires_at and sign_request.expires_at < timezone.now():
            raise TokenExpired("This signing link has expired.")
        return recipient

    def acting(self, token: str) -> Recipient:
        """As above, plus: it is your turn, you have consented, and you have
        not already finished."""
        recipient = self.recipient(token)
        if recipient.status == Recipient.Status.COMPLETED:
            raise TokenExpired("You have already completed this document.")
        if not routing.is_recipients_turn(recipient):
            raise TokenExpired("It is not your turn yet.")
        if recipient.needs_consent and recipient.consent_at is None:
            # 403, per §8B — this is a permission state, not a malformed
            # request, and the ceremony branches on it to show the consent
            # screen rather than an error.
            raise ConsentRequired()
        return recipient


class PublicSignDetailView(PublicSignBase):
    @extend_schema(responses=OpenApiTypes.OBJECT, tags=["esign-public"])
    def get(self, request, token):
        recipient = self.recipient(token)
        sign_request = recipient.sign_request
        if recipient.status in {Recipient.Status.PENDING,
                                Recipient.Status.NOTIFIED}:
            recipient.status = Recipient.Status.VIEWED
            recipient.save(update_fields=["status"])
            record(sign_request, "opened", recipient=recipient, request=request)

        owner = sign_request.owner
        version = sign_request.source_version
        return Response({
            "title": sign_request.title,
            "message": sign_request.message,
            "envelope_code": sign_request.envelope_code,
            "status": sign_request.status,
            "expires_at": sign_request.expires_at,
            "sender": {
                "name": (getattr(owner, "display_name", "") or "").strip(),
                "email": owner.email,
            },
            "me": {
                "name": recipient.name,
                "email": recipient.email,
                "role": recipient.role,
                "status": recipient.status,
                "consented": recipient.consent_at is not None,
                "needs_consent": recipient.needs_consent,
                "my_turn": routing.is_recipients_turn(recipient),
            },
            "page_count": version.page_count if version else 0,
            "fields": PublicFieldSerializer(
                recipient.fields.all(), many=True).data,
            "disclosure_version": VERSION,
        })


class PublicSignContentView(PublicSignBase):
    """The frozen source document, streamed."""

    @extend_schema(responses=OpenApiTypes.BINARY, tags=["esign-public"])
    def get(self, request, token):
        recipient = self.recipient(token)
        version = recipient.sign_request.source_version
        if version is None:
            raise TokenExpired("This request has no document yet.")
        data = get_storage().get_bytes(version.storage_key)
        response = HttpResponse(data, content_type="application/pdf")
        response["Content-Disposition"] = 'inline; filename="document.pdf"'
        response["Accept-Ranges"] = "bytes"
        return response


class PublicSignPageView(PublicSignBase):
    """One rendered page of the frozen document, for the ceremony's viewer.

    An image rather than the PDF: the signer sees the page *and* the boxes they
    are filling, positioned on it, and normalized §8 geometry maps onto the
    rendered image as plain CSS percentages with no conversion. Streaming the
    PDF into a viewer would mean shipping a PDF engine to a phone in order to
    show one page.
    """

    @extend_schema(responses=OpenApiTypes.BINARY, tags=["esign-public"])
    def get(self, request, token, page):
        recipient = self.recipient(token)
        version = recipient.sign_request.source_version
        if version is None:
            raise TokenExpired("This request has no document yet.")
        if not 0 <= page < version.page_count:
            raise ValidationFailed("That page is not in this document.")
        try:
            width = max(200, min(int(request.query_params.get("w", 900)), 1600))
        except ValueError:
            width = 900

        storage = get_storage()
        key = f"sign/{recipient.sign_request_id}/pages/p{page}@{width}.png"
        if storage.exists(key):
            png = storage.get_bytes(key)
        else:
            from apps.pdf_engine.engine import render as engine_render

            png = engine_render.render_thumbnail(
                storage.get_bytes(version.storage_key), page, width)
            storage.put_bytes(key, png, content_type="image/png")
        response = HttpResponse(png, content_type="image/png")
        response["Cache-Control"] = "private, max-age=3600"
        return response


class PublicSignDisclosureView(APIView):
    """The exact consent text, served from the repo (acceptance criterion 5)."""

    permission_classes = [AllowAny]
    authentication_classes: list = []

    @extend_schema(responses=OpenApiTypes.OBJECT, tags=["esign-public"])
    def get(self, request):
        return Response({"version": VERSION, "text": DISCLOSURE,
                         **consent_metadata()})


class PublicSignConsentView(PublicSignBase):
    @extend_schema(request=OpenApiTypes.OBJECT, responses=OpenApiTypes.OBJECT,
                   tags=["esign-public"])
    def post(self, request, token):
        recipient = self.recipient(token)
        if not request.data.get("agree"):
            raise ValidationFailed("You have to agree before you can sign.")
        if recipient.consent_at is None:
            from .models import client_ip

            recipient.consent_at = timezone.now()
            recipient.consent_ip = client_ip(request)
            recipient.consent_user_agent = (
                request.META.get("HTTP_USER_AGENT") or "")[:500]
            recipient.status = Recipient.Status.CONSENTED
            recipient.save(update_fields=["consent_at", "consent_ip",
                                          "consent_user_agent", "status"])
            # The hash of the exact text agreed to travels into the chain, so
            # the record still means something after the wording changes.
            record(recipient.sign_request, "consented", recipient=recipient,
                   request=request, **consent_metadata())
        return Response({"consented": True, **consent_metadata()})


class PublicSignFieldView(PublicSignBase):
    @extend_schema(request=OpenApiTypes.OBJECT, responses=OpenApiTypes.OBJECT,
                   tags=["esign-public"])
    def post(self, request, token):
        recipient = self.acting(token)
        field = recipient.fields.filter(id=request.data.get("field_id")).first()
        if field is None:
            # Scoped to *this* recipient's fields: one signer must not be able
            # to fill another's, and the token names the recipient.
            raise ValidationFailed("That field is not yours to fill.")
        if field.type == SignField.Type.DATE_SIGNED:
            raise ValidationFailed(
                "The date is filled in for you when you finish."
            )

        if field.type in SignField.IMAGE_TYPES:
            raw = _decode_data_url(request.data.get("signature_image"))
            if not raw:
                raise ValidationFailed("Draw or type your signature first.")
            try:
                png = SG.normalize_signature(raw)
            except EngineError as exc:
                raise ValidationFailed(exc.message) from exc
            key = f"sign/{recipient.sign_request_id}/fields/{field.id}.png"
            get_storage().put_bytes(key, png, content_type="image/png")
            field.image_key = key
        elif field.type == SignField.Type.CHECKBOX:
            field.value = "true" if request.data.get("value") in {
                True, "true", "on", "1"} else "false"
        else:
            field.value = str(request.data.get("value") or "")[:5000]
        field.filled_at = timezone.now()
        field.save(update_fields=["value", "image_key", "filled_at"])
        record(recipient.sign_request, "field_filled", recipient=recipient,
               request=request, field=str(field.id), type=field.type)
        return Response({"id": str(field.id), "filled": field.is_filled})


class PublicSignCompleteView(PublicSignBase):
    @extend_schema(request=None, responses=OpenApiTypes.OBJECT,
                   tags=["esign-public"])
    def post(self, request, token):
        recipient = self.acting(token)
        missing = [f.label or f.type for f in recipient.fields.all()
                   if f.required and not f.is_filled]
        if missing and recipient.role == Recipient.Role.SIGNER:
            raise ValidationFailed(
                "Some required fields are still empty: " + ", ".join(missing[:5])
            )

        event = ("approved" if recipient.role == Recipient.Role.APPROVER
                 else "signed")
        routing.complete_recipient(recipient, request=request, event=event)
        outcome = routing.advance(recipient.sign_request, request=request)
        if outcome == "completed":
            # §12 puts this on `heavy`: 60 s is not enough to burn every
            # field, seal and render a certificate for a real envelope.
            finalize_sign_request.apply_async(
                args=[str(recipient.sign_request_id)], queue="heavy")
        return Response({"completed": True, "next": outcome})


class PublicSignDeclineView(PublicSignBase):
    @extend_schema(request=OpenApiTypes.OBJECT, responses=OpenApiTypes.OBJECT,
                   tags=["esign-public"])
    def post(self, request, token):
        recipient = self.recipient(token)
        if recipient.status == Recipient.Status.COMPLETED:
            raise ValidationFailed("You have already completed this document.")
        routing.decline(recipient, str(request.data.get("reason") or ""),
                        request=request)
        return Response({"declined": True})


class PublicSignDownloadView(PublicSignBase):
    """A recipient's own copy of the finished document (ESIGN retention)."""

    @extend_schema(responses=OpenApiTypes.BINARY, tags=["esign-public"])
    def get(self, request, token, what):
        recipient = Recipient.objects.select_related("sign_request").filter(
            token=token).first()
        if recipient is None:
            raise TokenInvalid("This link is not valid.")
        sign_request = recipient.sign_request
        if sign_request.status != SignRequest.Status.COMPLETED:
            raise TokenExpired("This document is not finished yet.")
        return _stream_artifact(sign_request, what, request=request,
                                recipient=recipient)


# --------------------------------------------------------------------------- #
# 8C — verification, public
# --------------------------------------------------------------------------- #
class VerifyView(APIView):
    permission_classes = [AllowAny]
    authentication_classes: list = []
    throttle_scope = "image_upload"

    @extend_schema(request=OpenApiTypes.OBJECT, responses=OpenApiTypes.OBJECT,
                   tags=["esign-public"])
    def post(self, request):
        upload = request.FILES.get("file")
        if upload is None:
            raise ValidationFailed("Choose a PDF to check (field 'file').")
        if upload.size > settings.VERIFY_MAX_UPLOAD_BYTES:
            raise ValidationFailed("That file is too large to check here.")
        data = upload.read()

        try:
            report = SEAL.verify(data)
        except EngineError as exc:
            raise ValidationFailed(exc.message) from exc

        code = SEAL.find_envelope_code(data)
        envelope = {"found_code": code or None, "known": False,
                    "sha256_match": False}
        if code:
            import hashlib

            sign_request = SignRequest.objects.filter(envelope_code=code).first()
            if sign_request is not None:
                envelope["known"] = True
                envelope["sha256_match"] = bool(
                    sign_request.final_sha256
                    and sign_request.final_sha256 == hashlib.sha256(data).hexdigest()
                )
                # Who signed is told only to somebody holding the actual file.
                # The code is printed on every page and appears in every email
                # about the envelope, so a forwarded message or a photograph of
                # one page would otherwise be enough to ask us who signed what,
                # when, and at which employer.
                if envelope["sha256_match"]:
                    envelope["completed_at"] = sign_request.completed_at
                    envelope["signers"] = [
                        {"name": r.name, "email": _mask_email(r.email),
                         "role": r.role, "completed_at": r.completed_at}
                        for r in sign_request.recipients.all() if r.acts
                    ]
        report["envelope_match"] = envelope
        return Response(report)

    def get_throttles(self):
        """The scoped rate **in addition to** the defaults.

        `throttle_scope` on its own does nothing: the project's
        `DEFAULT_THROTTLE_CLASSES` contains no `ScopedRateThrottle`, so the
        declared 60/hour was inert and this endpoint ran on the 30/min anon
        bucket instead (same fix, and the same reason, as `core/views.py`).
        """
        return [*super().get_throttles(), ScopedRateThrottle()]



def _mask_email(email: str) -> str:
    """`a****@example.com` — enough to recognise your own address, not enough
    to harvest somebody else's from a document you were handed."""
    name, _, domain = email.partition("@")
    if not domain:
        return "—"
    head = name[:1]
    return f"{head}{'*' * max(3, len(name) - 1)}@{domain}"
