from django.contrib import admin

from .models import Job


@admin.register(Job)
class JobAdmin(admin.ModelAdmin):
    list_display = ("id", "type", "status", "progress", "user", "document", "created_at")
    list_filter = ("status", "type")
    search_fields = ("id", "user__email")
    readonly_fields = [f.name for f in Job._meta.fields]
