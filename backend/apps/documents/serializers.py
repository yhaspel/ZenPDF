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
    has_sign_requests = serializers.SerializerMethodField()

    class Meta:
        model = Document
        fields = ("id", "title", "status", "page_count", "size_bytes", "is_encrypted",
                  "starred", "folder", "metadata", "current_version", "last_opened_at",
                  "trashed_at", "created_at", "updated_at", "has_sign_requests")
        read_only_fields = ("id", "status", "page_count", "size_bytes", "is_encrypted",
                            "metadata", "current_version", "last_opened_at", "trashed_at",
                            "created_at", "updated_at", "has_sign_requests")

    def get_has_sign_requests(self, obj) -> bool:
        """Whether permanent deletion will be refused (`_purge`, §9).

        `source_version` is `on_delete=PROTECT` and `_purge` refuses before it
        touches a blob, so this document cannot be deleted for as long as any
        request points at it. The client needs to know *before* it offers the
        action: the trash card used to show "Delete forever", take the refusal,
        and turn it into a toast that faded — leaving the nightly `trash_purge`
        retry as the user's only remaining explanation, and that one is written
        to a log they cannot read.

        A boolean, not the reason: the reason is one sentence that belongs to
        `_purge` and stays there, so there is one copy of it.

        The list view annotates this with one `EXISTS` subquery so fifty rows
        cost one query rather than fifty-one; every other caller serializes a
        single document, where the fallback is the same single query the
        annotation would have been.
        """
        annotated = getattr(obj, "sign_requests_exist", None)
        if annotated is not None:
            return bool(annotated)
        return obj.sign_requests.exists()

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
    # The session password for an encrypted document (phase-07). A sibling of
    # `params`, not a member of it: it is a credential for the *document*, and
    # putting it in `params` would mean adding it to all forty op schemas —
    # each of which would then have to remember to ignore it.
    document_password = serializers.CharField(
        required=False, allow_blank=True, max_length=256, write_only=True,
    )
