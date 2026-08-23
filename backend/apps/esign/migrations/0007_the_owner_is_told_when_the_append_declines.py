"""The reason a signed copy never reached the source document.

`_append_to_source_document` is best-effort and always has been: the envelope is
complete and the sealed file downloadable either way, and there is no job to
fail because the ceremony belongs to the signer. What it did with the reason was
swallow it into a `logger.warning` — so an owner who was over quota, or whose
document had been trashed, learned nothing at all. Since the storage quota moved
onto the version write (§14), "over quota" is a routine reason rather than an
exotic one.

No backfill. An envelope completed before this column existed either appended
(`source_appended_at` is set) or did not, and in the second case the reason is
in a log file we are not going to parse into a user-facing sentence. NULL means
"nothing has failed as far as this row knows", which is the honest answer for
history.
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("esign", "0006_finalize_is_resumable"),
    ]

    operations = [
        migrations.AddField(
            model_name="signrequest",
            name="source_append_error",
            field=models.TextField(blank=True, null=True),
        ),
    ]
