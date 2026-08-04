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
        # `accepted_tos_at` is evidence, not a preference: it is the record that
        # this account agreed to the terms, and the whole point of recording a
        # timestamp is that nobody can claim it was never given. `PATCH
        # /api/users/me/ {"accepted_tos_at": null}` used to erase it (§9A).
        read_only_fields = ("id", "email", "email_verified", "accepted_tos_at",
                            "storage_bytes_used", "date_joined")


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
        """Tell the caller their address is taken — a deliberate, bounded leak.

        This is account enumeration: anyone can ask "is alice@example.com a
        ZenPDF user?" and get a straight answer (L14/B-SEC-4). Closing it means
        answering every signup with a success shape and mailing the existing
        account instead, which is the textbook fix and the wrong trade here:

        * The person who is actually stuck — one address, two attempts, a
          forgotten account — is left staring at a page that says it worked
          while nothing arrives, and the product's entire premise is that you
          can get your file out without an argument.
        * It buys less than it looks. The answer is already available: signing
          in with the address distinguishes "wrong password" from "no such
          account", and it would take a login flow that lies about *both* to
          actually close the channel.
        * The rate is bounded. `AuthThrottle` is 10/min **per IP**, and per-IP
          now means what it says (H1) — a directory of any size is not
          harvestable through this door.

        Written down rather than left implicit, so the next person deciding
        this is deciding it again rather than discovering it.
        """
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
