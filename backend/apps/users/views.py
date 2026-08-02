from django.conf import settings
from django.http import HttpResponse, HttpResponseRedirect
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import generics, status
from rest_framework.exceptions import Throttled
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from apps.core import captcha
from apps.core import limits as L
from apps.core.authentication import require_principal
from apps.core.claim import claim_if_token
from apps.core.exceptions import ValidationFailed
from apps.core.models import UsageCounter
from apps.core.permissions import IsAccount
from apps.core.principals import is_guest, label, owned_by
from apps.core.throttling import AuthThrottle

from .serializers import RegisterSerializer, UsageSerializer, UserSerializer
from .verification import (
    send_verification_email,
    user_from_verification_token,
    verification_send_allowed,
)


def _claim_inline(request, user, payload: dict) -> dict:
    """Claim the presented guest session onto `user`, annotating `payload`.

    An over-quota claim must not fail the authentication itself. The account
    exists either way, nothing was transferred (claim is all-or-nothing), and
    the client still holds the guest token — so the files remain reachable and
    the user can free space and retry via `POST /api/guest/claim/`, which does
    return the hard 429. Failing the login instead would lock someone out of
    their own account over a *guest* session. Recorded in the Decisions log.
    """
    from apps.core.exceptions import QuotaExceeded

    try:
        summary = claim_if_token(request, user)
    except QuotaExceeded as exc:
        payload["claim_error"] = {
            "code": exc.default_code,
            "message": str(exc.detail),
            "details": getattr(exc, "zen_details", {}),
        }
        return payload
    if summary:
        payload["claimed"] = summary
    return payload


class ThrottledTokenObtainPairView(TokenObtainPairView):
    """Login by email (§16 auth throttle 10/min/IP).

    Accepts an optional `X-Guest-Token` and claims that session inline on
    success — logging back in is as much a conversion moment as signing up
    (§21.5).
    """

    throttle_classes = [AuthThrottle]

    def post(self, request, *args, **kwargs):
        # Same flow as simplejwt's TokenViewBase.post, plus the inline claim —
        # written out because the base class does not expose `serializer.user`.
        serializer = self.get_serializer(data=request.data)
        try:
            serializer.is_valid(raise_exception=True)
        except TokenError as exc:
            raise InvalidToken(exc.args[0]) from exc
        payload = _claim_inline(request, serializer.user, dict(serializer.validated_data))
        return Response(payload, status=status.HTTP_200_OK)


class ThrottledTokenRefreshView(TokenRefreshView):
    throttle_classes = [AuthThrottle]


class RegisterView(generics.CreateAPIView):
    """`POST /api/users/register/` — note the route is *not* `/api/auth/register/`.

    Accepts an optional `X-Guest-Token`: the work the visitor already did
    follows them into the new account, in one transaction (§21.5).
    """

    serializer_class = RegisterSerializer
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [AuthThrottle]

    @extend_schema(tags=["users"])
    def post(self, request, *args, **kwargs):
        # Behind `CAPTCHA_ENABLED`, off in dev and test (§9B). Registration is
        # the door to an account that can send mail in our name.
        captcha.enforce_standalone(request)
        response = super().post(request, *args, **kwargs)
        if response.status_code == status.HTTP_201_CREATED:
            from django.contrib.auth import get_user_model

            user = get_user_model().objects.filter(id=response.data.get("id")).first()
            if user is not None:
                _claim_inline(request, user, response.data)
                # Mail the link here, or the verification gate is unreachable
                # from a cold start: nothing else in the product asks for it,
                # and the person who needs it has not seen a settings screen.
                send_verification_email(user)
        return response


class MeView(generics.RetrieveUpdateAPIView):
    serializer_class = UserSerializer
    permission_classes = [IsAccount]

    def get_object(self):
        return self.request.user

    @extend_schema(tags=["users"])
    def get(self, request, *args, **kwargs):
        return super().get(request, *args, **kwargs)

    @extend_schema(tags=["users"])
    def patch(self, request, *args, **kwargs):
        return super().patch(request, *args, **kwargs)


class ExportView(APIView):
    """`GET /api/users/me/export/` — everything we hold, as a zip (§10.1).

    Inline rather than a job: it is bounded by the account's own storage quota,
    and a download that needs polling is a download most people abandon. The
    privacy policy offers this, so it exists.
    """

    permission_classes = [IsAccount]

    @extend_schema(responses=OpenApiTypes.BINARY, tags=["users"])
    def get(self, request):
        from .privacy import export_zip

        data, filename = export_zip(request.user)
        response = HttpResponse(data, content_type="application/zip")
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
        return response


class DeleteAccountView(APIView):
    """`DELETE /api/users/me/delete/` — close the account and erase it (§10.1).

    Requires the current password in the body. Not because the session is in
    doubt, but because this is the one irreversible action in the product and a
    borrowed laptop should not be enough to take somebody's library with it.

    What survives is stated plainly in the response and in the privacy policy:
    completed signature envelopes, which are the *other parties'* evidence of
    an agreement, detached from the account that sent them.
    """

    permission_classes = [IsAccount]
    throttle_classes = [AuthThrottle]

    @extend_schema(request=OpenApiTypes.OBJECT, responses=OpenApiTypes.OBJECT,
                   tags=["users"])
    def delete(self, request):
        password = str(request.data.get("password") or "")
        if not request.user.check_password(password):
            raise ValidationFailed(
                "That password is not right. Deleting an account cannot be "
                "undone, so we ask before doing it."
            )
        from .privacy import delete_account

        removed = delete_account(request.user)
        return Response({"deleted": True, **removed})


class UsageView(APIView):
    """Consumption for **either** principal (§16).

    A guest sees current-session usage — storage, ops, time remaining. What it
    cannot have is history *across* sessions, which needs durable counters
    (§21.3).
    """

    permission_classes = [AllowAny]

    @extend_schema(responses=UsageSerializer, tags=["users"])
    def get(self, request):
        principal = require_principal(request)
        tier = L.for_principal(principal)
        period = timezone.now().strftime("%Y-%m")
        counter = owned_by(
            UsageCounter.objects.filter(period=period), principal
        ).first() if principal is not None else None

        data = {
            "period": period,
            "principal": label(principal),
            "tier": tier.tier,
            "storage": {
                "used_bytes": L.storage_used(principal),
                "quota_bytes": tier.storage_bytes,
            },
            "counters": {
                "sign_requests": counter.sign_requests if counter else 0,
                "ocr_pages": counter.ocr_pages if counter else 0,
                "conversions": counter.conversions if counter else 0,
                "heavy_ops": counter.heavy_ops if counter else 0,
                "metered_ops_this_hour": L.metered_ops_used_this_hour(principal),
            },
            "limits": tier.as_api_dict(),
        }
        if is_guest(principal):
            data["session"] = {
                "expires_at": principal.expires_at.isoformat(),
                "seconds_remaining": max(
                    0, int((principal.expires_at - timezone.now()).total_seconds())
                ),
            }
        return Response(data)


class LogoutView(APIView):
    """Blacklist the presented refresh token (§17 rotate+blacklist)."""

    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [AuthThrottle]

    @extend_schema(tags=["users"], request=None, responses={200: None})
    def post(self, request):
        refresh = request.data.get("refresh")
        if not refresh:
            raise ValidationFailed("A refresh token is required to log out.")
        try:
            RefreshToken(refresh).blacklist()
        except TokenError as exc:
            raise ValidationFailed("Invalid or already-expired refresh token.") from exc
        return Response({"detail": "Logged out."}, status=status.HTTP_200_OK)


# --------------------------------------------------------------------------- #
# Email verification (§9B) — accounts only, and never a gate on uploading
# --------------------------------------------------------------------------- #
class SendVerificationView(APIView):
    """`POST /api/users/verify/send/` — mail a fresh verification link."""

    permission_classes = [IsAccount]
    throttle_classes = [AuthThrottle]

    @extend_schema(request=None, responses=OpenApiTypes.OBJECT, tags=["users"])
    def post(self, request):
        if request.user.email_verified:
            return Response({"verified": True, "sent": False})
        if not verification_send_allowed(request.user):
            # Registration does not prove the address belongs to whoever typed
            # it, so an uncapped resend is a mailbomb aimed at a stranger —
            # and this mail is transactional, so the suppression list cannot
            # save them. The cooldown is the cap.
            raise Throttled(
                detail="We have just sent one. Check your inbox, or try again "
                       "in a few minutes.")
        send_verification_email(request.user)
        return Response({"verified": False, "sent": True})


class VerifyEmailView(APIView):
    """`POST /api/users/verify/` `{token}` — confirm the address.

    Deliberately open to anyone holding the token: the link arrives in an email
    client that may not be the browser that is signed in, and asking somebody
    to log in before they can prove they own the address is a circle.
    """

    permission_classes = [AllowAny]
    authentication_classes: list = []
    throttle_classes = [AuthThrottle]

    @extend_schema(request=OpenApiTypes.OBJECT, responses=OpenApiTypes.OBJECT,
                   tags=["users"])
    def post(self, request):
        user = user_from_verification_token(str(request.data.get("token") or ""))
        if user is None:
            raise ValidationFailed(
                "That verification link is not valid any more. Ask for a new one."
            )
        if not user.email_verified:
            user.email_verified = True
            user.save(update_fields=["email_verified"])
        return Response({"verified": True, "email": user.email})


class UnsubscribeView(APIView):
    """`/api/mail/unsubscribe/<token>/` — the RFC 8058 one-click endpoint.

    Three callers, one URL:

    * **Gmail/Yahoo POST it** with `List-Unsubscribe=One-Click` and no
      JavaScript in sight. This has to be the API — a link to a client-rendered
      route would return the app shell and suppress nothing while telling the
      person they were unsubscribed.
    * **A person clicks it** in the footer. A GET does *not* suppress: an
      unsubscribe link is printed in every message and forwarded with them, and
      one that fires on load lets anyone downstream silently and permanently
      cut somebody off. So a GET redirects to the page that asks.
    * **That page POSTs** when they confirm, and can `DELETE` to undo.

    No auth: the token in the mail is the authority, and somebody who wants out
    must not have to sign in to get out.
    """

    permission_classes = [AllowAny]
    authentication_classes: list = []
    throttle_classes = [AuthThrottle]

    def _digest(self, token: str) -> str:
        from apps.core.mail import hash_from_unsubscribe_token

        digest = hash_from_unsubscribe_token(token)
        if not digest:
            raise ValidationFailed("That unsubscribe link is not valid.")
        return digest

    @extend_schema(responses=OpenApiTypes.OBJECT, tags=["core"])
    def get(self, request, token: str):
        # Confirm-first, deliberately: see the class docstring.
        return HttpResponseRedirect(
            f"{settings.FRONTEND_BASE_URL}/unsubscribe/{token}")

    @extend_schema(request=None, responses=OpenApiTypes.OBJECT, tags=["core"])
    def post(self, request, token: str):
        from apps.core.mail import suppress_hash

        suppress_hash(self._digest(token), reason="unsubscribe")
        return Response({"unsubscribed": True})

    @extend_schema(request=None, responses=OpenApiTypes.OBJECT, tags=["core"])
    def delete(self, request, token: str):
        from apps.core.mail import unsuppress_hash

        unsuppress_hash(self._digest(token))
        return Response({"unsubscribed": False})
