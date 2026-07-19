"""Send a test email — proves SMTP/Mailpit wiring (phase-00 acceptance)."""
from django.conf import settings
from django.core.mail import send_mail
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Send a test email to verify SMTP (Mailpit) delivery."

    def add_arguments(self, parser):
        parser.add_argument("--to", default="test@zenpdf.local")

    def handle(self, *args, **options):
        to = options["to"]
        send_mail(
            subject="ZenPDF test email",
            message="If you can read this in Mailpit, SMTP works.",
            from_email=settings.DEFAULT_FROM_EMAIL,
            recipient_list=[to],
            fail_silently=False,
        )
        self.stdout.write(self.style.SUCCESS(f"Test email sent to {to} via {settings.EMAIL_HOST}:{settings.EMAIL_PORT}"))
