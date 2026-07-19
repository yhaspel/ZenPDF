"""Seed the dev/demo user + sample documents (up.sh step, §5; phase-01)."""
import os

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand

from apps.documents.services import ingest_pdf

FIXTURES = os.path.join(settings.BASE_DIR, "tests", "fixtures", "pdfs")
SAMPLES = [
    ("text.pdf", "Sample invoice"),
    ("unicode.pdf", "Unicode sample"),
    ("form.pdf", "Job application form"),
    ("rotated-90.pdf", "Rotated scan"),
]


class Command(BaseCommand):
    help = "Create the seed admin/demo user and upload sample documents."

    def handle(self, *args, **options):
        User = get_user_model()
        email = settings.SEED_ADMIN_EMAIL
        user, created = User.objects.get_or_create(
            email=email.lower(),
            defaults={"is_staff": True, "is_superuser": True, "display_name": "ZenPDF Admin",
                      "email_verified": True},
        )
        if created:
            user.set_password(settings.SEED_ADMIN_PASSWORD)
            user.save()
            self.stdout.write(self.style.SUCCESS(f"Created seed user {email}"))
        else:
            self.stdout.write(f"Seed user {email} already exists")

        if user.documents.exists():
            self.stdout.write("Sample documents already present; skipping upload.")
            return

        for filename, title in SAMPLES:
            path = os.path.join(FIXTURES, filename)
            if not os.path.exists(path):
                self.stdout.write(self.style.WARNING(f"Fixture missing: {filename}"))
                continue
            with open(path, "rb") as fh:
                data = fh.read()
            try:
                ingest_pdf(user, data, title)
                self.stdout.write(self.style.SUCCESS(f"Uploaded {title}"))
            except Exception as exc:  # noqa: BLE001
                self.stdout.write(self.style.WARNING(f"Failed to upload {filename}: {exc}"))
