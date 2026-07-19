"""Create the object-storage bucket idempotently (up.sh step, §5)."""
from django.core.management.base import BaseCommand

from apps.pdf_engine.storage import get_storage


class Command(BaseCommand):
    help = "Create the ZenPDF storage bucket if it does not exist."

    def handle(self, *args, **options):
        storage = get_storage()
        storage.ensure_bucket()
        self.stdout.write(self.style.SUCCESS("Storage bucket ready."))
