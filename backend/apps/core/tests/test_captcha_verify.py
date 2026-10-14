"""Turnstile verification itself, and the standalone gate (§17c, §9B).

`test_guest_abuse.py` pins *when* a guest is challenged and monkeypatches
`verify_token` away. What that leaves unpinned is the adapter boundary: the
exact shape Cloudflare's answer must have before a token counts as solved, and
that `enforce_standalone` accepts the token from either the header or the body
and refuses on anything else. "Network failure = reject" is the property that
keeps a Cloudflare outage from turning into an open registration endpoint.
"""
import json
from unittest.mock import MagicMock, patch

import pytest
from django.test import RequestFactory
from rest_framework.parsers import JSONParser
from rest_framework.request import Request

from apps.core import captcha
from apps.core.exceptions import CaptchaRequired

pytestmark = pytest.mark.django_db


def _response(ok: bool, payload):
    resp = MagicMock()
    resp.ok = ok
    resp.json.return_value = payload
    return resp


@pytest.fixture
def on(settings):
    settings.CAPTCHA_ENABLED = True
    settings.TURNSTILE_SECRET_KEY = "secret"
    settings.TURNSTILE_VERIFY_URL = "https://turnstile.invalid/siteverify"
    return settings


# --------------------------------------------------------------------------- #
# verify_token
# --------------------------------------------------------------------------- #
def test_an_empty_token_is_rejected_without_a_round_trip(on):
    with patch("requests.post") as post:
        assert captcha.verify_token("") is False
    post.assert_not_called()


def test_a_token_cloudflare_accepts_is_accepted(on):
    with patch("requests.post", return_value=_response(True, {"success": True})) as post:
        assert captcha.verify_token("tok", "203.0.113.9") is True
    kwargs = post.call_args.kwargs
    assert post.call_args.args[0] == "https://turnstile.invalid/siteverify"
    assert kwargs["data"] == {"secret": "secret", "response": "tok",
                              "remoteip": "203.0.113.9"}
    assert kwargs["timeout"] == 5


def test_the_remote_ip_is_omitted_when_unknown(on):
    with patch("requests.post", return_value=_response(True, {"success": True})) as post:
        captcha.verify_token("tok")
    assert "remoteip" not in post.call_args.kwargs["data"]


def test_a_token_cloudflare_refuses_is_refused(on):
    body = {"success": False, "error-codes": ["invalid-input-response"]}
    with patch("requests.post", return_value=_response(True, body)):
        assert captcha.verify_token("tok") is False


def test_a_truthy_but_non_boolean_success_is_not_enough(on):
    with patch("requests.post", return_value=_response(True, {"success": "true"})):
        assert captcha.verify_token("tok") is False


def test_a_non_ok_http_status_is_a_refusal_even_if_the_body_says_success(on):
    with patch("requests.post", return_value=_response(False, {"success": True})):
        assert captcha.verify_token("tok") is False


def test_a_network_failure_is_a_refusal_not_a_crash(on):
    with patch("requests.post", side_effect=ConnectionError("down")):
        assert captcha.verify_token("tok") is False


def test_an_unparseable_body_is_a_refusal(on):
    resp = _response(True, None)
    resp.json.side_effect = ValueError("not json")
    with patch("requests.post", return_value=resp):
        assert captcha.verify_token("tok") is False


# --------------------------------------------------------------------------- #
# enforce_standalone
# --------------------------------------------------------------------------- #
def _drf_request(*, header: str = "", body: dict | None = None):
    factory = RequestFactory()
    extra: dict[str, str] = {"HTTP_X_CAPTCHA_TOKEN": header} if header else {}
    raw = factory.post("/api/users/register/", data=json.dumps(body or {}),
                       content_type="application/json", REMOTE_ADDR="198.51.100.4",
                       **extra)  # type: ignore[arg-type]  # the stubs type **extra as the positional params
    return Request(raw, parsers=[JSONParser()])


def test_standalone_is_a_no_op_when_captcha_is_off(settings):
    settings.CAPTCHA_ENABLED = False
    with patch.object(captcha, "verify_token") as verify:
        captcha.enforce_standalone(_drf_request())
    verify.assert_not_called()


def test_standalone_accepts_the_header_token_and_passes_the_client_ip(on):
    with patch.object(captcha, "verify_token", return_value=True) as verify:
        captcha.enforce_standalone(_drf_request(header="hdr-tok", body={"captcha_token": "body"}))
    verify.assert_called_once_with("hdr-tok", "198.51.100.4")


def test_standalone_falls_back_to_the_body_token(on):
    with patch.object(captcha, "verify_token", return_value=True) as verify:
        captcha.enforce_standalone(_drf_request(body={"captcha_token": "body-tok"}))
    verify.assert_called_once_with("body-tok", "198.51.100.4")


def test_standalone_refuses_when_the_token_does_not_verify(on):
    with patch.object(captcha, "verify_token", return_value=False):
        with pytest.raises(CaptchaRequired) as exc:
            captcha.enforce_standalone(_drf_request(header="bad"))
    assert exc.value.default_code == "captcha_required"


def test_standalone_refuses_when_no_token_was_sent_at_all(on):
    with patch("requests.post") as post:
        with pytest.raises(CaptchaRequired):
            captcha.enforce_standalone(_drf_request())
    post.assert_not_called()


def test_registration_is_gated_end_to_end_when_captcha_is_on(on, anon):
    """The gate on the real route: a bad token is a 403 before any account is
    created, and a good one lets the registration through."""
    from django.contrib.auth import get_user_model

    payload = {"email": "gated@example.com", "password": "strongpass123",
               "accept_terms": True}
    with patch("requests.post", return_value=_response(True, {"success": False})):
        resp = anon.post("/api/users/register/", payload, format="json",
                         HTTP_X_CAPTCHA_TOKEN="bad")
    assert resp.status_code == 403, resp.content
    assert resp.json()["error"]["code"] == "captcha_required"
    assert not get_user_model().objects.filter(email="gated@example.com").exists()

    with patch("requests.post", return_value=_response(True, {"success": True})):
        resp = anon.post("/api/users/register/", payload, format="json",
                         HTTP_X_CAPTCHA_TOKEN="good")
    assert resp.status_code == 201, resp.content
