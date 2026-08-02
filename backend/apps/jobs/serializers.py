from rest_framework import serializers

from .models import Job


class JobSerializer(serializers.ModelSerializer):
    # Never the raw params: an encrypted document's password travels in them
    # (phase-07), and the job detail endpoint is polled by the client that just
    # sent it — echoing it back puts it in every proxy log on the way.
    params = serializers.SerializerMethodField()

    def get_params(self, obj) -> dict:
        return obj.redacted_params()

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
            "error_details",
            "result",
            "created_at",
            "started_at",
            "finished_at",
        )
        read_only_fields = fields
