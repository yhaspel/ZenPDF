"""Admin for signature requests and abuse reports (§9B).

The point of this screen is one job: somebody has reported a request, and a
human has to look at it and decide. So the list leads with the report count and
the status, and the actions are the two decisions that follow — pause it, or
clear it and let it run.

Audit events are **not** editable here. They are the evidence the certificate
is printed from, and an admin who can rewrite them is exactly the hole the hash
chain exists to close.
"""
from django.contrib import admin, messages
from django.utils import timezone

from .models import AbuseReport, AuditEvent, Recipient, SignField, SignRequest


class RecipientInline(admin.TabularInline):
    model = Recipient
    extra = 0
    fields = ("email", "name", "role", "order", "status", "completed_at")
    readonly_fields = fields
    # The token is a capability. Showing it here would let anyone with admin
    # read access sign as that person.
    can_delete = False

    def has_add_permission(self, request, obj=None) -> bool:
        return False


class AbuseReportInline(admin.TabularInline):
    model = AbuseReport
    extra = 0
    fields = ("created_at", "recipient", "reason", "ip")
    readonly_fields = fields
    can_delete = False

    def has_add_permission(self, request, obj=None) -> bool:
        return False


@admin.register(SignRequest)
class SignRequestAdmin(admin.ModelAdmin):
    list_display = ("envelope_code", "title", "owner", "status", "report_count",
                    "sent_at", "completed_at")
    list_filter = ("status",)
    search_fields = ("envelope_code", "title", "owner__email", "recipients__email")
    readonly_fields = ("envelope_code", "final_sha256", "final_key",
                       "certificate_key", "created_at", "sent_at", "completed_at")
    inlines = [RecipientInline, AbuseReportInline]
    actions = ["pause_for_abuse", "clear_reports"]

    @admin.display(description="reports")
    def report_count(self, obj) -> int:
        return obj.abuse_reports.values("recipient_id").distinct().count()

    @admin.action(description="Pause (reported as abuse) and tell the owner")
    def pause_for_abuse(self, request, queryset):
        from . import emails
        from .models import record

        paused = 0
        for sign_request in queryset:
            if sign_request.is_terminal:
                continue
            sign_request.status = SignRequest.Status.CANCELED_BY_ABUSE
            sign_request.save(update_fields=["status"])
            record(sign_request, "canceled", request=request, reason="admin_review")
            emails.notify_paused_for_abuse(
                sign_request, self.report_count(sign_request))
            paused += 1
        self.message_user(request, f"Paused {paused} request(s).", messages.WARNING)

    @admin.action(description="Clear reports (reviewed, not abuse)")
    def clear_reports(self, request, queryset):
        """Deletes the *reports*, never the audit trail.

        A request paused by reports stays paused: un-pausing would put a
        document back in front of people who said they did not want it. The
        owner sends a fresh one if it was a mistake.
        """
        cleared = 0
        for sign_request in queryset:
            cleared += sign_request.abuse_reports.count()
            sign_request.abuse_reports.all().delete()
        self.message_user(request, f"Cleared {cleared} report(s).")


@admin.register(AbuseReport)
class AbuseReportAdmin(admin.ModelAdmin):
    list_display = ("created_at", "sign_request", "recipient", "ip")
    list_filter = ("created_at",)
    search_fields = ("sign_request__envelope_code", "recipient__email", "reason")
    readonly_fields = ("sign_request", "recipient", "reason", "ip", "user_agent",
                       "created_at")

    def has_add_permission(self, request) -> bool:
        return False


@admin.register(AuditEvent)
class AuditEventAdmin(admin.ModelAdmin):
    """Read-only, deliberately.

    The chain is the evidence a certificate is printed from. Editing one entry
    here would break every hash after it — and an admin who *can* edit it is
    the hole the chain exists to close.
    """

    list_display = ("created_at", "sign_request", "type", "recipient", "ip")
    list_filter = ("type",)
    search_fields = ("sign_request__envelope_code", "recipient__email")
    readonly_fields = ("sign_request", "recipient", "type", "created_at", "ip",
                       "user_agent", "metadata", "prev_hash", "event_hash")

    def has_add_permission(self, request) -> bool:
        return False

    def has_change_permission(self, request, obj=None) -> bool:
        return False

    def has_delete_permission(self, request, obj=None) -> bool:
        return False


@admin.register(SignField)
class SignFieldAdmin(admin.ModelAdmin):
    list_display = ("sign_request", "recipient", "type", "page", "required",
                    "filled_at")
    list_filter = ("type", "required")
    search_fields = ("sign_request__envelope_code", "recipient__email")


@admin.action(description="Ban: deactivate and stop their signature requests")
def _ban_users(modeladmin, request, queryset):
    """Deactivate accounts and stop their open signature requests (§9B)."""
    from .models import record

    banned = queryset.update(is_active=False)
    stopped = 0
    for sign_request in SignRequest.objects.filter(
            owner__in=queryset, status__in=SignRequest.OPEN_STATUSES):
        sign_request.status = SignRequest.Status.CANCELED_BY_ABUSE
        sign_request.save(update_fields=["status"])
        record(sign_request, "canceled", request=request, reason="owner_banned")
        stopped += 1
    modeladmin.message_user(
        request, f"Deactivated {banned} account(s); stopped {stopped} request(s).",
        messages.WARNING,
    )


@admin.action(description="Move to trash (recoverable for 30 days)")
def _soft_delete_documents(modeladmin, request, queryset):
    """Move to trash rather than destroy: the 30-day window is what makes a
    mistaken moderation call recoverable (§9B)."""
    moved = queryset.filter(trashed_at__isnull=True).update(
        trashed_at=timezone.now())
    modeladmin.message_user(request, f"Moved {moved} document(s) to trash.")

