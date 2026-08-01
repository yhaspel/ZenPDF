from django.apps import AppConfig


class CoreConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.core"

    def ready(self):
        # Registers the OpenAPI security schemes for PrincipalAuthentication.
        from . import schema  # noqa: F401
