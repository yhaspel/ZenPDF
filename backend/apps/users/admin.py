from django.contrib import admin
from django.contrib.auth.admin import UserAdmin

from .models import User


@admin.register(User)
class ZenUserAdmin(UserAdmin):
    ordering = ("email",)
    list_display = ("email", "display_name", "is_staff", "email_verified",
                    "storage_bytes_used", "is_active")
    list_filter = ("is_active", "email_verified", "is_staff", "plan")
    search_fields = ("email", "display_name")
    # Moderation (§9B). Banning also stops the account's open signature
    # requests — leaving those running would keep mailing strangers in the name
    # of an account we have just disabled.
    actions = ["ban_accounts"]

    @admin.action(description="Ban: deactivate and stop their signature requests")
    def ban_accounts(self, request, queryset):
        from apps.esign.admin import _ban_users

        _ban_users(self, request, queryset)

    def delete_model(self, request, obj):
        """Delete through the same path the account holder uses.

        A plain `user.delete()` raises `ProtectedError` for anybody who ever
        sent an envelope — `SignRequest.source_version` is `PROTECT`, and
        `PROTECT` fires even when the protecting row is part of the same
        cascade. Before phase 10 that was a latent bug because admin was
        `DEBUG`-only; now that production can reach this screen it would be a
        500 on the moderation page. `delete_account` detaches first, keeps the
        signed envelopes, and cleans up storage after the transaction commits.
        """
        from .privacy import delete_account

        delete_account(obj)

    def delete_queryset(self, request, queryset):
        from .privacy import delete_account

        for user in queryset:
            delete_account(user)
    fieldsets = (
        (None, {"fields": ("email", "password")}),
        ("Profile", {"fields": ("display_name", "email_verified", "accepted_tos_at")}),
        ("Storage", {"fields": ("storage_bytes_used",)}),
        ("Permissions", {"fields": ("is_active", "is_staff", "is_superuser", "groups", "user_permissions")}),
        ("Dates", {"fields": ("last_login", "date_joined")}),
    )
    add_fieldsets = (
        (None, {"classes": ("wide",), "fields": ("email", "password1", "password2")}),
    )
