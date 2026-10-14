"""`UserManager` — the email-login manager behind every `create_user` call.

The register endpoint is tested end to end in `test_auth.py`, but
`create_superuser` is only ever reached from `manage.py createsuperuser`, and
the "email is required" and "superuser flags cannot be contradicted" guards
were never exercised. Those guards are what stop an operator from minting a
staff account that cannot log in to the admin.
"""
import pytest
from django.contrib.auth import get_user_model

pytestmark = pytest.mark.django_db

User = get_user_model()


def test_create_user_refuses_an_empty_email():
    with pytest.raises(ValueError, match="email address is required"):
        User.objects.create_user(email="", password="pass12345")


def test_create_user_refuses_a_missing_email():
    with pytest.raises(ValueError, match="email address is required"):
        User.objects.create_user(email=None, password="pass12345")


def test_create_user_lowercases_and_normalizes_the_email():
    user = User.objects.create_user(email="Carol@Example.COM", password="pass12345")
    assert user.email == "carol@example.com"
    assert User.objects.get(pk=user.pk).email == "carol@example.com"


def test_create_user_hashes_the_password_rather_than_storing_it():
    user = User.objects.create_user(email="dave@example.com", password="pass12345")
    assert user.password != "pass12345"
    assert user.check_password("pass12345")


def test_create_user_is_neither_staff_nor_superuser_by_default():
    user = User.objects.create_user(email="erin@example.com", password="pass12345")
    assert user.is_staff is False
    assert user.is_superuser is False


def test_create_superuser_sets_both_flags():
    user = User.objects.create_superuser(email="Root@Example.com", password="pass12345")
    assert user.is_staff is True
    assert user.is_superuser is True
    assert user.email == "root@example.com"
    assert user.check_password("pass12345")


def test_create_superuser_refuses_is_staff_false():
    with pytest.raises(ValueError, match="is_staff=True"):
        User.objects.create_superuser(
            email="root@example.com", password="pass12345", is_staff=False
        )
    assert not User.objects.filter(email="root@example.com").exists()


def test_create_superuser_refuses_is_superuser_false():
    with pytest.raises(ValueError, match="is_superuser=True"):
        User.objects.create_superuser(
            email="root@example.com", password="pass12345", is_superuser=False
        )
    assert not User.objects.filter(email="root@example.com").exists()


def test_create_superuser_requires_an_email_too():
    with pytest.raises(ValueError, match="email address is required"):
        User.objects.create_superuser(email="", password="pass12345")
