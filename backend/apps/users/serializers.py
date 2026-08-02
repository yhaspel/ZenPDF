from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.utils import timezone
from rest_framework import serializers

User = get_user_model()


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = (
            "id",
            "email",
            "display_name",
            "email_verified",
            "accepted_tos_at",
            "storage_bytes_used",
            "date_joined",
        )
        read_only_fields = ("id", "email", "email_verified", "storage_bytes_used", "date_joined")


class RegisterSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, style={"input_type": "password"})
    #: The signup checkbox (§9A). Required, unticked by default, and recorded
    #: with a timestamp — "they must have agreed, they have an account" is not
    #: something we would want to have to say later.
    accept_terms = serializers.BooleanField(write_only=True)

    class Meta:
        model = User
        fields = ("id", "email", "password", "display_name", "accept_terms")
        read_only_fields = ("id",)

    def validate_email(self, value: str) -> str:
        value = value.lower().strip()
        if User.objects.filter(email__iexact=value).exists():
            raise serializers.ValidationError("An account with this email already exists.")
        return value

    def validate_password(self, value: str) -> str:
        validate_password(value)
        return value

    def validate_accept_terms(self, value: bool) -> bool:
        if not value:
            raise serializers.ValidationError(
                "Please accept the Terms and Privacy Policy to continue.")
        return value

    def create(self, validated_data):
        validated_data.pop("accept_terms", None)
        return User.objects.create_user(
            email=validated_data["email"],
            password=validated_data["password"],
            display_name=validated_data.get("display_name", ""),
            accepted_tos_at=timezone.now(),
        )


class UsageSerializer(serializers.Serializer):
    period = serializers.CharField()
    storage = serializers.DictField()
    counters = serializers.DictField()
