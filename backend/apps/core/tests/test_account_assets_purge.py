"""`account_assets_purge` — the sweep an account never had (queue, 2026-08-01).

`purge_principal_assets` runs for guest purge and account deletion only. A
guest's stamps die with the session inside the hour; an **account's** were
charged against the storage quota for ever, with no screen anywhere that could
free them. §13 calls `uploads/…` ephemeral — stamps and watermarks are
re-uploaded per session by design and a conversion source is discarded the
moment its job finishes — so a week is generous.

The load-bearing test in this file is the exempt one. The handoff that
commissioned this work assumed saved signatures "live elsewhere". They do not:
§13 deliberately put `SavedSignature.storage_key` in this very prefix so
signatures would inherit its quota metering, its principal-derived key and its
guest purge. A sweep that believed the assumption would delete a stored image of
somebody's signature and leave the row pointing at nothing.
"""
import zlib
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.core.assets import asset_key, principal_prefix, store_image
from apps.core.tasks import account_assets_purge
from apps.pdf_engine.storage import FilesystemStorage, get_storage

pytestmark = pytest.mark.django_db


def _tiny_png() -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (len(payload).to_bytes(4, "big") + kind + payload
                + zlib.crc32(kind + payload).to_bytes(4, "big"))

    raw = b"".join(b"\x00" + b"\x10\x20\x30" * 4 for _ in range(4))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", (4).to_bytes(4, "big") + (4).to_bytes(4, "big")
                    + bytes([8, 2, 0, 0, 0]))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


def _age(key: str, days: float) -> None:
    """Backdate a blob's mtime.

    Filesystem-backend specific and deliberately so: the hermetic suite runs on
    it, and age is the thing under test. The isinstance check is not ceremony —
    it is what makes the failure read "this test needs the filesystem backend"
    rather than an AttributeError from inside S3Storage.
    """
    import os

    storage = get_storage()
    assert isinstance(storage, FilesystemStorage), (
        "these tests backdate blobs on disk; run them under the hermetic "
        "settings, where STORAGE_BACKEND is 'filesystem'"
    )
    path = storage._path(key)  # noqa: SLF001 - the test owns the backend here
    when = (timezone.now() - timedelta(days=days)).timestamp()
    os.utime(path, (when, when))


def _counter(user) -> int:
    user.refresh_from_db()
    return int(user.storage_bytes_used)


def test_a_stale_asset_is_swept_and_the_bytes_refunded(user):
    ref = store_image(user, _tiny_png())["ref"]
    key = asset_key(user, ref)
    charged = _counter(user)
    size = get_storage().head(key)["size"]
    assert charged >= size > 0

    _age(key, 30)
    stats = account_assets_purge()

    assert stats["blobs"] == 1
    assert stats["bytes"] == size
    assert not get_storage().exists(key)
    assert _counter(user) == charged - size


def test_a_fresh_asset_is_left_alone(user):
    ref = store_image(user, _tiny_png())["ref"]
    key = asset_key(user, ref)
    charged = _counter(user)

    stats = account_assets_purge()

    assert stats["blobs"] == 0
    assert get_storage().exists(key)
    assert _counter(user) == charged


def test_an_asset_inside_the_window_is_left_alone(user):
    """Six days old against a seven-day retention: the edge, named."""
    ref = store_image(user, _tiny_png())["ref"]
    key = asset_key(user, ref)
    _age(key, 6)

    assert account_assets_purge()["blobs"] == 0
    assert get_storage().exists(key)


def test_a_saved_signature_is_never_touched(user, api):
    """The one thing in this prefix a user deliberately kept.

    `SavedSignature.storage_key` is an ordinary asset key here (§13) — not a
    namespace of its own — so age alone would delete it. It is excluded by key,
    and this test is the reason the exclusion exists.
    """
    from apps.esign.models import SavedSignature

    ref = store_image(user, _tiny_png())["ref"]
    key = asset_key(user, ref)
    SavedSignature.objects.create(user=user, kind="signature", method="draw",
                                  storage_key=key)
    charged = _counter(user)

    _age(key, 365)
    stats = account_assets_purge()

    assert stats["blobs"] == 0
    assert stats["kept"] >= 1
    assert get_storage().exists(key), "a saved signature was deleted by age"
    assert _counter(user) == charged
    assert SavedSignature.objects.get(storage_key=key)


def test_a_stale_asset_beside_a_saved_signature_still_goes(user):
    """The exemption is per key, not per account — one kept signature must not
    make the rest of the prefix immortal."""
    from apps.esign.models import SavedSignature

    kept_key = asset_key(user, store_image(user, _tiny_png())["ref"])
    SavedSignature.objects.create(user=user, kind="signature", method="draw",
                                  storage_key=kept_key)
    stale_key = asset_key(user, store_image(user, _tiny_png())["ref"])

    _age(kept_key, 365)
    _age(stale_key, 365)
    stats = account_assets_purge()

    assert stats["blobs"] == 1
    assert get_storage().exists(kept_key)
    assert not get_storage().exists(stale_key)


def test_the_bytes_are_refunded_exactly_once(user):
    """`bump_storage` has no floor. Refunding twice would leave the account
    owing bytes that nothing will ever pay back, and `enforce_storage` would
    then let it write past its quota for ever."""
    key = asset_key(user, store_image(user, _tiny_png())["ref"])
    charged = _counter(user)
    size = get_storage().head(key)["size"]

    _age(key, 30)
    assert account_assets_purge()["blobs"] == 1
    after = _counter(user)
    assert after == charged - size

    # The blob is gone; a second sweep must find nothing to credit.
    assert account_assets_purge()["blobs"] == 0
    assert _counter(user) == after


def test_a_conversion_source_is_swept_too(user):
    """Since phase-06 every non-PDF the dashboard accepts lands in this prefix.
    `discard_source` removes it when the job finishes — this is the one whose
    job never did."""
    from apps.core.assets import source_key, store_source

    parked = store_source(user, b"%PDF-1.4 not really, just bytes\n" * 40,
                          "letter.docx")
    key = source_key(user, parked["ref"], "docx")
    assert get_storage().exists(key)

    _age(key, 30)
    assert account_assets_purge()["blobs"] == 1
    assert not get_storage().exists(key)


def test_a_guest_prefix_is_not_touched(guest, guest_doc, user):
    """`guest_purge` owns those and takes the whole prefix at expiry, which is
    sooner and more complete. Two sweeps deleting the same blobs would refund
    the same bytes twice."""
    from apps.core.models import GuestSession

    session = GuestSession.objects.get()
    ref = store_image(session, _tiny_png())["ref"]
    key = asset_key(session, ref)
    _age(key, 365)

    assert account_assets_purge()["blobs"] == 0
    assert get_storage().exists(key)
    assert key.startswith(principal_prefix(session))


def test_one_account_is_never_charged_or_swept_for_another(user, other_user):
    """It walks every account, so crossing one is the failure that matters."""
    mine = asset_key(user, store_image(user, _tiny_png())["ref"])
    theirs = asset_key(other_user, store_image(other_user, _tiny_png())["ref"])
    theirs_charged = _counter(other_user)

    _age(mine, 30)
    account_assets_purge()

    assert not get_storage().exists(mine)
    assert get_storage().exists(theirs)
    assert _counter(other_user) == theirs_charged


def test_the_window_is_configurable(user, settings):
    settings.ASSET_RETENTION_DAYS = 1
    key = asset_key(user, store_image(user, _tiny_png())["ref"])
    _age(key, 2)

    assert account_assets_purge()["blobs"] == 1


def test_the_sweep_and_the_reconciler_agree(user):
    """After a sweep the counter must be exactly what `usage_recompute` would
    compute — otherwise the nightly pair fight each other."""
    from apps.core.tasks import charged_bytes, usage_recompute

    key = asset_key(user, store_image(user, _tiny_png())["ref"])
    store_image(user, _tiny_png())
    _age(key, 30)

    account_assets_purge()
    assert _counter(user) == charged_bytes(user)

    assert usage_recompute()["healed"] == 0
