from django.utils import timezone
from drf_spectacular.utils import extend_schema
from rest_framework import generics, status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from apps.core.exceptions import ValidationFailed
from apps.core.models import UsageCounter
from apps.core.throttling import AuthThrottle

from .serializers import RegisterSerializer, UsageSerializer, UserSerializer


class ThrottledTokenObtainPairView(TokenObtainPairView):
    """Login by email (§16 auth throttle 10/min/IP)."""

    throttle_classes = [AuthThrottle]


class ThrottledTokenRefreshView(TokenRefreshView):
    throttle_classes = [AuthThrottle]


class RegisterView(generics.CreateAPIView):
    serializer_class = RegisterSerializer
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [AuthThrottle]

    @extend_schema(tags=["users"])
    def post(self, request, *args, **kwargs):
        return super().post(request, *args, **kwargs)


class MeView(generics.RetrieveUpdateAPIView):
    serializer_class = UserSerializer
    permission_classes = [IsAuthenticated]

    def get_object(self):
        return self.request.user

    @extend_schema(tags=["users"])
    def get(self, request, *args, **kwargs):
        return super().get(request, *args, **kwargs)

    @extend_schema(tags=["users"])
    def patch(self, request, *args, **kwargs):
        return super().patch(request, *args, **kwargs)


class UsageView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(responses=UsageSerializer, tags=["users"])
    def get(self, request):
        from django.conf import settings

        user = request.user
        period = timezone.now().strftime("%Y-%m")
        counter = UsageCounter.objects.filter(user=user, period=period).first()
        data = {
            "period": period,
            "storage": {
                "used_bytes": user.storage_bytes_used,
                "quota_bytes": settings.USER_STORAGE_QUOTA_MB * 1024 * 1024,
            },
            "counters": {
                "sign_requests": counter.sign_requests if counter else 0,
                "ocr_pages": counter.ocr_pages if counter else 0,
                "conversions": counter.conversions if counter else 0,
            },
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
