"""OpenAPI extensions (01-architecture.md §6).

`PrincipalAuthentication` resolves two different credentials, so the schema has
to declare both — otherwise every principal-authenticated endpoint documents no
security scheme at all, and the guest credential this phase introduces is
invisible to anyone reading the API docs.
"""
from drf_spectacular.extensions import OpenApiAuthenticationExtension


class PrincipalAuthenticationScheme(OpenApiAuthenticationExtension):
    target_class = "apps.core.authentication.PrincipalAuthentication"
    name = ["jwtAuth", "guestToken"]

    def get_security_definition(self, auto_schema):
        return [
            {
                "type": "http",
                "scheme": "bearer",
                "bearerFormat": "JWT",
                "description": "Account principal (§21.2).",
            },
            {
                "type": "apiKey",
                "in": "header",
                "name": "X-Guest-Token",
                "description": (
                    "Guest principal (§21.2). Minted lazily on the first write "
                    "and returned once in the `X-Guest-Token` response header."
                ),
            },
        ]
