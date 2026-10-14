"""`init_sentry` — the switch that is an environment variable, not a deploy (§10.4).

`test_observability.py` pins the scrubber and the no-DSN short circuit. These
pin the two outcomes once a DSN *is* set: the SDK is initialised with the
configured DSN, environment, release and — above all — the PII scrubber and
`send_default_pii=False`; and a machine that sets a DSN without the prod-only
package is told why nothing arrived rather than crashing on startup.
"""
import logging
import sys
import types

import pytest

from apps.core.observability import _before_send, init_sentry, redact


@pytest.fixture
def dsn(settings):
    settings.SENTRY_DSN = "https://key@sentry.invalid/1"
    settings.SENTRY_ENVIRONMENT = "staging"
    settings.SENTRY_RELEASE = "zenpdf@1.2.3"
    settings.SENTRY_TRACES_SAMPLE_RATE = 0.25
    return settings


def test_a_dsn_without_the_sdk_installed_warns_and_stays_off(dsn, monkeypatch, caplog):
    monkeypatch.setitem(sys.modules, "sentry_sdk", None)  # makes `import` raise
    with caplog.at_level(logging.WARNING, logger="apps.core.observability"):
        assert init_sentry() is False
    assert "sentry-sdk is not installed" in caplog.text


def test_a_dsn_with_the_sdk_initialises_it_with_the_scrubber(dsn, monkeypatch):
    calls = []
    fake = types.ModuleType("sentry_sdk")
    fake.init = lambda **kwargs: calls.append(kwargs)
    monkeypatch.setitem(sys.modules, "sentry_sdk", fake)

    assert init_sentry() is True
    assert len(calls) == 1
    kwargs = calls[0]
    assert kwargs["dsn"] == "https://key@sentry.invalid/1"
    assert kwargs["environment"] == "staging"
    assert kwargs["release"] == "zenpdf@1.2.3"
    assert kwargs["traces_sample_rate"] == 0.25
    assert kwargs["send_default_pii"] is False
    assert kwargs["before_send"] is _before_send


def test_an_empty_release_is_sent_as_none_not_an_empty_string(dsn, monkeypatch):
    dsn.SENTRY_RELEASE = ""
    calls = []
    fake = types.ModuleType("sentry_sdk")
    fake.init = lambda **kwargs: calls.append(kwargs)
    monkeypatch.setitem(sys.modules, "sentry_sdk", fake)

    assert init_sentry() is True
    assert calls[0]["release"] is None


def test_redact_passes_non_strings_through_untouched():
    for value in (None, 42, 3.5, ["alice@example.com"], {"k": "v"}):
        assert redact(value) is value


def test_redact_strips_addresses_and_capability_tokens():
    token = "A" * 40
    assert redact(f"mail to alice@example.com with {token}") == "mail to [email] with [token]"
    assert redact("https://zen/s/abcdef123456?x=1") == "https://zen/s/[token]?x=1"
