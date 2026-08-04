"""M4 — the two markers that let a killed finalize be finished by its redelivery.

The tail of `finalize_sign_request` runs after the COMPLETED status is
committed, and `acks_late` on the `heavy` lane means a worker killed in that
window is redelivered. The certificate and the audit events can tell whether
they already happened; sending mail and appending a version cannot, so each
gets a timestamp.

The backfill matters as much as the columns: every envelope that is *already*
completed has had its tail run, and leaving those two fields null would tell a
future resume to mail every recipient a second copy of a document they signed
weeks ago. `completed_at` is the honest stamp for work that finished then.
"""
from django.db import migrations, models


def mark_existing_completions_as_done(apps, schema_editor):
    SignRequest = apps.get_model("esign", "SignRequest")
    SignRequest.objects.filter(status="completed").update(
        completed_notified_at=models.F("completed_at"),
        source_appended_at=models.F("completed_at"),
    )


class Migration(migrations.Migration):

    dependencies = [
        ("esign", "0005_signrequest_sign_owner_recent"),
    ]

    operations = [
        migrations.AddField(
            model_name="signrequest",
            name="completed_notified_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="signrequest",
            name="source_appended_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.RunPython(mark_existing_completions_as_done,
                             migrations.RunPython.noop),
    ]
