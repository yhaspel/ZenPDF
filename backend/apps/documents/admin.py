from django.contrib import admin

from .models import Document, DocumentVersion, Folder


@admin.register(Folder)
class FolderAdmin(admin.ModelAdmin):
    list_display = ("name", "owner", "parent", "created_at")
    search_fields = ("name", "owner__email")


class VersionInline(admin.TabularInline):
    model = DocumentVersion
    extra = 0
    readonly_fields = ("seq", "label", "size_bytes", "page_count", "sha256", "created_at")


@admin.register(Document)
class DocumentAdmin(admin.ModelAdmin):
    list_display = ("title", "owner", "status", "page_count", "size_bytes", "starred", "trashed_at")
    list_filter = ("status", "starred")
    search_fields = ("title", "owner__email")
    inlines = [VersionInline]
