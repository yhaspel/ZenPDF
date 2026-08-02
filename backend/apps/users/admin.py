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
