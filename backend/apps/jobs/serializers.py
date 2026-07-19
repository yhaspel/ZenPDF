from rest_framework import serializers

from .models import Job


class JobSerializer(serializers.ModelSerializer):
    class Meta:
        model = Job
        fields = (
            "id",
            "type",
            "document",
            "status",
            "progress",
            "params",
            "base_version_seq",
            "error_code",
            "error_message",
            "result",
            "created_at",
            "started_at",
            "finished_at",
        )
        read_only_fields = fields
