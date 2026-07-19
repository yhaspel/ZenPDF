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


class OperationRequestSerializer(serializers.Serializer):
    type = serializers.CharField()
    params = serializers.DictField(required=False, default=dict)
    base_version_seq = serializers.IntegerField(required=False, allow_null=True)
