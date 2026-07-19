import pytest
from django.contrib.auth import get_user_model
from django.core import mail
from django.core.management import call_command

pytestmark = pytest.mark.django_db


def test_init_storage_runs():
    call_command("init_storage")  # filesystem backend → ensure dir


def test_seed_dev_creates_user_and_docs():
    call_command("seed_dev")
    user = get_user_model().objects.get(email="admin@zenpdf.local")
    assert user.is_superuser
    assert user.documents.count() >= 1
    # idempotent: second run doesn't duplicate
    call_command("seed_dev")
    assert get_user_model().objects.filter(email="admin@zenpdf.local").count() == 1


def test_send_test_email_lands_in_outbox(settings):
    settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
    call_command("send_test_email", "--to", "someone@example.com")
    assert len(mail.outbox) == 1
    assert mail.outbox[0].to == ["someone@example.com"]
