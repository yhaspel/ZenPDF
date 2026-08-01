from django.utils import timezone
from drf_spectacular.utils import extend_schema
from rest_framework import generics, status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from apps.core import limits as L
from apps.core.authentication import require_principal
from apps.core.claim import claim_if_token
from apps.core.exceptions import ValidationFailed
from apps.core.models import UsageCounter
from apps.core.permissions import IsAccount
from apps.core.principals import is_guest, label, owned_by
from apps.core.throttling import AuthThrottle

from .serializers import RegisterSerializer, UsageSerializer, UserSerializer


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
        response = super().post(request, *args, **kwargs)
        if response.status_code == status.HTTP_201_CREATED:
            from django.contrib.auth import get_user_model

            user = get_user_model().objects.filter(id=response.data.get("id")).first()
            if user is not None:
                _claim_inline(request, user, response.data)
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
