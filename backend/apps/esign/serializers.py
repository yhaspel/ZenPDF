"""Wire shapes for e-signatures (phase-08)."""
from __future__ import annotations

from rest_framework import serializers

from .models import AuditEvent, Recipient, SavedSignature, SignField, SignRequest


class SavedSignatureSerializer(serializers.ModelSerializer):
    class Meta:
        model = SavedSignature
        fields = ("id", "kind", "method", "typed_text", "font", "is_default",
                  "created_at")
        read_only_fields = fields


class SignFieldSerializer(serializers.ModelSerializer):
    """A field as the builder sees it. `value` is deliberately writable only
    through the ceremony's own endpoint — the owner never fills a signer's
    field, which is the whole point of sending it to them."""

    recipient_id = serializers.UUIDField()
    filled = serializers.BooleanField(source="is_filled", read_only=True)

    class Meta:
        model = SignField
        fields = ("id", "recipient_id", "page", "x", "y", "w", "h", "type",
                  "required", "label", "filled")
        read_only_fields = ("id", "filled")


class RecipientSerializer(serializers.ModelSerializer):
    """Owner-side view. **No token** — that is the recipient's capability, and
    putting it in the owner's list would make forwarding the JSON equivalent to
    forwarding the ability to sign as them."""

    class Meta:
        model = Recipient
        fields = ("id", "email", "name", "role", "order", "status",
                  "completed_at", "last_notified_at", "decline_reason")
        read_only_fields = ("id", "status", "completed_at", "last_notified_at",
                            "decline_reason")


class AuditEventSerializer(serializers.ModelSerializer):
    recipient_email = serializers.CharField(source="recipient.email", default="",
                                            read_only=True)

    class Meta:
        model = AuditEvent
        fields = ("id", "type", "created_at", "ip", "user_agent", "metadata",
                  "recipient_email", "event_hash")
        read_only_fields = fields


class SignRequestSerializer(serializers.ModelSerializer):
    recipients = RecipientSerializer(many=True, read_only=True)
    fields_ = SignFieldSerializer(many=True, read_only=True, source="fields")
    document_title = serializers.CharField(source="document.title", read_only=True)
    page_count = serializers.SerializerMethodField()

    class Meta:
        model = SignRequest
        fields = ("id", "document", "document_title", "title", "message", "status",
                  "envelope_code", "expires_at", "reminder_every_days", "sent_at",
                  "completed_at", "final_sha256", "created_at", "recipients",
                  "fields_", "page_count")
        read_only_fields = ("id", "status", "envelope_code", "sent_at",
                            "completed_at", "final_sha256", "created_at")

    def get_page_count(self, obj) -> int:
        version = obj.source_version or obj.document.current_version
        return version.page_count if version else 0


class SignRequestCreateSerializer(serializers.Serializer):
    document = serializers.UUIDField()
    title = serializers.CharField(max_length=255, required=False, allow_blank=True)
    message = serializers.CharField(required=False, allow_blank=True,
                                    max_length=5000)
    expires_in_days = serializers.IntegerField(required=False, min_value=1,
                                               max_value=365)
    reminder_every_days = serializers.IntegerField(required=False, min_value=0,
                                                   max_value=90)


class RecipientWriteSerializer(serializers.Serializer):
    email = serializers.EmailField()

    def validate_email(self, value: str) -> str:
        # Normalized on the way in, so `Bob@x.com` and `bob@x.com` are one
        # person everywhere downstream — the daily recipient cap counts
        # distinct addresses, and case is not a distinction.
        return value.strip().lower()
    name = serializers.CharField(max_length=200, required=False, allow_blank=True)
    role = serializers.ChoiceField(choices=Recipient.Role.choices,
                                   default=Recipient.Role.SIGNER)
    order = serializers.IntegerField(min_value=1, max_value=50, default=1)


class FieldWriteSerializer(serializers.Serializer):
    recipient_id = serializers.UUIDField()
    page = serializers.IntegerField(min_value=0)
    x = serializers.FloatField(min_value=0, max_value=1)
    y = serializers.FloatField(min_value=0, max_value=1)
    w = serializers.FloatField(min_value=0.001, max_value=1)
    h = serializers.FloatField(min_value=0.001, max_value=1)
    type = serializers.ChoiceField(choices=SignField.Type.choices)
    required = serializers.BooleanField(default=True)
    label = serializers.CharField(max_length=100, required=False, allow_blank=True)


class PublicFieldSerializer(serializers.ModelSerializer):
    """What a recipient sees of their own fields — never another's."""

    filled = serializers.BooleanField(source="is_filled", read_only=True)

    class Meta:
        model = SignField
        fields = ("id", "page", "x", "y", "w", "h", "type", "required", "label",
                  "value", "filled")
        read_only_fields = fields
