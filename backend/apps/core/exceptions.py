"""Error shape + custom API exceptions (01-architecture.md §6).

All non-2xx responses share:
    {"error": {"code": "<machine_code>", "message": "<human>", "details": {...}}}
"""
from __future__ import annotations

from typing import Any

from rest_framework import status
from rest_framework.exceptions import APIException


class ZenAPIException(APIException):
    """Base for ZenPDF domain errors carrying a stable machine `code`."""

    status_code: int = status.HTTP_400_BAD_REQUEST
    default_code: str = "error"
    default_detail: str = "An error occurred."


class ValidationFailed(ZenAPIException):
    status_code = status.HTTP_400_BAD_REQUEST
    default_code = "validation_error"
    default_detail = "Validation failed."


class VersionConflict(ZenAPIException):
    status_code = status.HTTP_409_CONFLICT
    default_code = "version_conflict"
    default_detail = "The document changed since you last loaded it."


class QuotaExceeded(ZenAPIException):
    status_code = status.HTTP_429_TOO_MANY_REQUESTS
    default_code = "quota_exceeded"
    default_detail = "Quota exceeded."


class FileTooLarge(ZenAPIException):
    status_code = status.HTTP_413_REQUEST_ENTITY_TOO_LARGE
    default_code = "file_too_large"
    default_detail = "The uploaded file is too large."


class UnsupportedFile(ZenAPIException):
    status_code = status.HTTP_415_UNSUPPORTED_MEDIA_TYPE
    default_code = "unsupported_file"
    default_detail = "The file could not be read as a PDF."


class DocumentEncrypted(ZenAPIException):
    status_code = status.HTTP_423_LOCKED
    default_code = "document_encrypted"
    default_detail = "This document is encrypted. Unlock it before editing."


class TokenInvalid(ZenAPIException):
    status_code = status.HTTP_401_UNAUTHORIZED
    default_code = "token_invalid"
    default_detail = "This link is invalid."


class TokenExpired(ZenAPIException):
    status_code = status.HTTP_410_GONE
    default_code = "token_expired"
    default_detail = "This link has expired or is no longer active."


class AccountRequired(ZenAPIException):
    """A guest hit an account-only feature (§21.3).

    403, and the UI turns it into a signup prompt — never a dead end.
    """

    status_code = status.HTTP_403_FORBIDDEN
    default_code = "account_required"
    default_detail = "Create a free account to use this feature."


class GuestExpired(ZenAPIException):
    """The guest session is past its TTL or has been claimed (§21.4, §21.5).

    410, deliberately distinct from 404: the client must be able to tell
    "your session ended" from "that isn't yours".
    """

    status_code = status.HTTP_410_GONE
    default_code = "guest_expired"
    default_detail = "Your guest session has ended and its files were deleted."


class CaptchaRequired(ZenAPIException):
    """A metered op needs a one-per-session challenge first (§17c)."""

    status_code = status.HTTP_403_FORBIDDEN
    default_code = "captcha_required"
    default_detail = "Please complete the verification challenge to continue."


# Map DRF's built-in exception default_code values onto our stable machine codes.
_DRF_CODE_MAP = {
    "not_authenticated": "not_authenticated",
    "authentication_failed": "authentication_failed",
    "permission_denied": "permission_denied",
    "not_found": "not_found",
    "method_not_allowed": "method_not_allowed",
    "not_acceptable": "not_acceptable",
    "unsupported_media_type": "unsupported_file",
    "throttled": "throttled",
    "parse_error": "validation_error",
    "invalid": "validation_error",
}


def _extract_code(exc: Exception, response) -> str:
    code = getattr(exc, "default_code", None) or getattr(exc, "code", None)
    if isinstance(exc, ZenAPIException):
        return exc.default_code
    if code in _DRF_CODE_MAP:
        return _DRF_CODE_MAP[code]
    status_code = getattr(response, "status_code", 500)
    return {
        400: "validation_error",
        401: "authentication_failed",
        403: "permission_denied",
        404: "not_found",
        405: "method_not_allowed",
        409: "version_conflict",
        410: "guest_expired",
        413: "file_too_large",
        415: "unsupported_file",
        423: "document_encrypted",
        429: "throttled",
    }.get(status_code, "error")


def _human_message(exc: Exception, data: Any) -> str:
    detail = getattr(exc, "detail", None)
    if isinstance(detail, str):
        return str(detail)
    if isinstance(detail, dict):
        return "Validation failed."
    if isinstance(detail, (list, tuple)) and detail:
        return str(detail[0])
    if isinstance(data, str):
        return data
    return "An error occurred."


def zenpdf_exception_handler(exc, context):
    """DRF exception handler that reshapes every error into the ZenPDF shape."""
    # Imported lazily: this module is reached from the default authentication
    # class, which DRF resolves *while* rest_framework.views is still being
    # imported — a module-level import here is a circular import at startup.
    from rest_framework.views import exception_handler as drf_exception_handler

    response = drf_exception_handler(exc, context)
    if response is None:
        return None

    original = response.data
    details: dict[str, Any] = {}
    if isinstance(original, dict) and "detail" not in original:
        details = {"fields": original}
    elif isinstance(original, dict):
        extra = {k: v for k, v in original.items() if k != "detail"}
        if extra:
            details = extra

    # ZenAPIException may attach structured details.
    exc_details = getattr(exc, "zen_details", None)
    if isinstance(exc_details, dict):
        details = {**details, **exc_details}

    code = _extract_code(exc, response)
    message = _human_message(exc, original)

    # Throttled carries a Retry-After header; surface wait in details.
    wait = getattr(exc, "wait", None)
    if wait is not None:
        details.setdefault("retry_after_seconds", int(wait))

    response.data = {"error": {"code": code, "message": message, "details": details}}
    return response
