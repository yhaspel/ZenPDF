from django.apps import AppConfig


class CoreConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.core"

    def ready(self):
        # Registers the OpenAPI security schemes for PrincipalAuthentication.
        from . import schema  # noqa: F401
        from .observability import init_sentry

        # No DSN, no SDK, no network calls — which is what makes it safe to
        # have this line in every environment (§10.4).
        init_sentry()
