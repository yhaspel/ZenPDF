"""Admin for the mail suppression list (§9B).

It exists for one reason: **undo**. The unsubscribe link is printed in every
message and travels with it when somebody forwards an invitation, so a
suppression can be created by a person who is not the addressee. Without a way
to remove a row, that is a permanent, unappealable block on a stranger's mail —
so staff can delete one, and the person themselves can undo it from the page
the link lands on.

The address is only stored when we already knew it (a staff entry, a bounce).
A one-click unsubscribe leaves it blank, because the token carries a keyed hash
and not an email — see `core/mail.py`.
"""
from django.contrib import admin

from .models import EmailSuppression


@admin.register(EmailSuppression)
class EmailSuppressionAdmin(admin.ModelAdmin):
    list_display = ("__str__", "reason", "created_at")
    list_filter = ("reason",)
    search_fields = ("email", "email_hash")
    readonly_fields = ("email_hash", "created_at")
