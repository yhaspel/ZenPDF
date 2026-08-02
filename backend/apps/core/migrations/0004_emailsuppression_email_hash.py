"""Key the suppression list on a keyed hash of the address (§9B).

The unsubscribe link carries this value, and a URL carrying somebody's email
address ends up in browser history, proxy logs and `Referer` headers — the same
reason `users/verification.py` signs a user id rather than an address.
"""
from django.db import migrations, models


def fill_hashes(apps, schema_editor):
    from apps.core.mail import address_hash

    Suppression = apps.get_model("core", "EmailSuppression")
    for row in Suppression.objects.all():
        row.email_hash = address_hash(row.email)
        row.save(update_fields=["email_hash"])


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0003_usagecounter_heavy_ops_alter_usagecounter_user_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="emailsuppression",
            name="email_hash",
            field=models.CharField(default="", max_length=64),
            preserve_default=False,
        ),
        migrations.RunPython(fill_hashes, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="emailsuppression",
            name="email_hash",
            field=models.CharField(max_length=64, unique=True),
        ),
        migrations.AlterField(
            model_name="emailsuppression",
            name="email",
            field=models.EmailField(blank=True, default="", max_length=254),
        ),
    ]
