"""A refusal always says when to try again (01-architecture.md §16, §6).

The workspace turns a 429 into "this is busy" rather than "this is broken" by
disabling **Try again** and counting down — and the countdown is read from
`details.retry_after_seconds`, which `apps/core/exceptions.py` copies off
`Throttled.wait`. When `wait` is `None` the whole chain degrades at once: no
`Retry-After` header, no "Expected available in N seconds" in the message, no
`details`, and a button whose only possible outcome is a second refusal.

DRF returns `None` from `SimpleRateThrottle.wait()` when
`num_requests - len(history) + 1 <= 0`. Hammering cannot reach that —
`throttle_success` only appends while `len(history) < num_requests` — so it
takes a history recorded under a *higher* rate than the one now in force,
which is what an operator turning the limits down under load produces.
"""
import pytest

from apps.core.models import GuestSession
from apps.core.throttling import GuestIPThrottle, GuestThrottle

pytestmark = pytest.mark.django_db

IP = "198.51.100.77"


def _rates(settings, guest):
    return {**settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"], "guest": guest}


def _set_rate(monkeypatch, settings, guest):
    """`monkeypatch`, not assignment: THROTTLE_RATES is a class attribute, and a
    raw write would leave every later test in the session running at this rate."""
    for cls in (GuestThrottle, GuestIPThrottle):
        monkeypatch.setattr(cls, "THROTTLE_RATES", _rates(settings, guest), raising=False)
        monkeypatch.setattr(cls, "rate", None, raising=False)


def _ask(anon, raw):
    return anon.get("/api/documents/", HTTP_X_GUEST_TOKEN=raw, REMOTE_ADDR=IP)


def _refuse(anon, raw, tries=8):
    """Ask until refused, and hand back the refusal."""
    for _ in range(tries):
        resp = _ask(anon, raw)
        if resp.status_code == 429:
            return resp
    raise AssertionError("the throttle never refused — the rate is not in force")


def test_an_ordinary_refusal_says_when(anon, settings, monkeypatch):
    _set_rate(monkeypatch, settings, "3/min")
    _session, raw = GuestSession.mint(ip=IP)

    resp = _refuse(anon, raw)

    assert resp["Retry-After"]
    assert int(resp["Retry-After"]) > 0
    envelope = resp.json()["error"]
    assert envelope["code"] == "throttled"
    assert envelope["details"]["retry_after_seconds"] > 0
    # The server's own sentence carries it too — the workspace shows this text.
    assert "Expected available in" in envelope["message"]


def test_a_history_larger_than_the_allowance_still_says_when(anon, settings, monkeypatch):
    """The regression this file exists for.

    Fill the bucket at one rate, drop the rate under it, ask again. Before
    `AlwaysSaysWhenMixin` this answered `{"details": {}}` with no `Retry-After`
    and a message that had lost its "Expected available in N seconds" clause —
    reproduced against the running stack on 2026-08-25 before it was written.
    """
    _set_rate(monkeypatch, settings, "3/min")
    _session, raw = GuestSession.mint(ip=IP)
    _refuse(anon, raw)  # history now holds 3 entries

    # The operator turns the guests down. The cache keeps yesterday's history.
    _set_rate(monkeypatch, settings, "1/min")

    resp = _ask(anon, raw)

    assert resp.status_code == 429
    assert resp["Retry-After"], "a 429 with no Retry-After tells nobody anything"
    assert int(resp["Retry-After"]) > 0
    envelope = resp.json()["error"]
    assert envelope["details"]["retry_after_seconds"] > 0
    assert "Expected available in" in envelope["message"]


def test_the_wait_it_names_is_when_room_actually_appears(settings, monkeypatch):
    """Not merely non-null — the right number.

    With four entries against an allowance of two, room appears when the
    history drops *below* two, i.e. when the second-newest expires. Naming the
    oldest instead would send the caller back early to be refused again.
    """
    _set_rate(monkeypatch, settings, "2/min")
    throttle = GuestThrottle()
    throttle.rate = "2/min"
    throttle.num_requests, throttle.duration = 2, 60
    throttle.now = 1_000.0
    # Newest first, as DRF stores them: ages 5 s, 15 s, 25 s, 35 s.
    throttle.history = [995.0, 985.0, 975.0, 965.0]

    # index = num_requests - 1 = 1 → the 15 s-old entry, which expires in 45 s.
    assert throttle.wait() == pytest.approx(45.0)


def test_an_ordinary_wait_is_unchanged_by_the_mixin(settings, monkeypatch):
    """The mixin must be invisible whenever DRF already has an answer."""
    _set_rate(monkeypatch, settings, "2/min")
    throttle = GuestThrottle()
    throttle.rate = "2/min"
    throttle.num_requests, throttle.duration = 2, 60
    throttle.now = 1_000.0
    throttle.history = [995.0, 985.0]  # exactly the allowance

    # DRF's own formula: (60 - (1000 - 985)) / (2 - 2 + 1) = 45.
    assert throttle.wait() == pytest.approx(45.0)


def test_a_rate_that_allows_nothing_names_the_window(settings, monkeypatch):
    _set_rate(monkeypatch, settings, "0/min")
    throttle = GuestThrottle()
    throttle.rate = "0/min"
    throttle.num_requests, throttle.duration = 0, 60
    throttle.now = 1_000.0
    throttle.history = [995.0]

    # No moment is honest here, so the window length is the least misleading
    # answer — and it is still a number, which is the point.
    assert throttle.wait() == 60
