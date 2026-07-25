from rest_framework import serializers

from .models import Document, DocumentVersion, Folder


class FolderSerializer(serializers.ModelSerializer):
    class Meta:
        model = Folder
        fields = ("id", "name", "parent", "created_at")
        read_only_fields = ("id", "created_at")

    def validate(self, attrs):
        owner = self.context["request"].user
        parent = attrs.get("parent", getattr(self.instance, "parent", None))
        name = attrs.get("name", getattr(self.instance, "name", None))
        qs = Folder.objects.filter(owner=owner, parent=parent, name=name)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError("A folder with this name already exists here.")
        if parent and parent.owner_id != owner.id:
            raise serializers.ValidationError("Invalid parent folder.")
        if self.instance and parent:
            # A folder may not become its own ancestor — a cycle makes the
            # cascade-delete walk in FolderDetailView.destroy non-terminating.
            seen = set()
            node = parent
            while node is not None and node.pk not in seen:
                if node.pk == self.instance.pk:
                    raise serializers.ValidationError("A folder cannot be moved inside itself.")
                seen.add(node.pk)
                node = node.parent
        return attrs


class VersionRefSerializer(serializers.ModelSerializer):
    class Meta:
        model = DocumentVersion
        fields = ("id", "seq", "label")


class DocumentVersionSerializer(serializers.ModelSerializer):
    job_type = serializers.CharField(source="job.type", read_only=True, default=None)
    created_by = serializers.EmailField(source="created_by.email", read_only=True, default=None)

    class Meta:
        model = DocumentVersion
        fields = ("id", "seq", "label", "size_bytes", "page_count", "sha256",
                  "created_by", "job_type", "created_at")
        read_only_fields = fields


class DocumentSerializer(serializers.ModelSerializer):
    current_version = VersionRefSerializer(read_only=True)

    class Meta:
        model = Document
        fields = ("id", "title", "status", "page_count", "size_bytes", "is_encrypted",
                  "starred", "folder", "metadata", "current_version", "last_opened_at",
                  "trashed_at", "created_at", "updated_at")
        read_only_fields = ("id", "status", "page_count", "size_bytes", "is_encrypted",
                            "metadata", "current_version", "last_opened_at", "trashed_at",
                            "created_at", "updated_at")

    def validate_folder(self, value):
        # `folder` is a writable relation whose default queryset is unscoped;
        # without this a PATCH could file a document into another user's folder.
        if value is not None and value.owner_id != self.context["request"].user.id:
            raise serializers.ValidationError("Invalid folder.")
        return value


class OperationRequestSerializer(serializers.Serializer):
    type = serializers.CharField()
    params = serializers.DictField(required=False, default=dict)
    base_version_seq = serializers.IntegerField(required=False, allow_null=True)
