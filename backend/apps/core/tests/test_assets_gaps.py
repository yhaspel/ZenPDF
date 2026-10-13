"""`apps.core.assets` — the refusals and the storage-failure fallbacks.

The happy paths (store, load, move, purge) are exercised through the API in
`test_annotations_api.py`, `test_convert_api.py` and `test_account_assets_purge.py`.
What was never pinned is the *shape of the refusal*: a bad header must be
refused before anything is decoded, a lying header must still be caught after,
a CMYK JPEG must come out as a PNG the engine can use, and every helper that
sweeps a prefix must survive one blob it cannot read or delete.
"""
import io
from unittest.mock import patch

import pytest
from django.test import override_settings
from PIL import Image

from apps.core import assets
from apps.core import limits as L
from apps.core.assets import (
    AssetQuotaExceeded,
    ImageRejected,
    asset_key,
    discard_source,
    header_dimensions,
    load_images,
    load_source,
    move_assets,
    normalize_png,
    principal_prefix,
    purge_principal_assets,
    source_key,
    store_image,
    store_source,
)
from apps.pdf_engine.storage import get_storage

pytestmark = pytest.mark.django_db


def _png(width: int = 4, height: int = 4) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), (16, 32, 48)).save(buf, format="PNG")
    return buf.getvalue()


def _jpeg(mode: str = "RGB", size=(8, 8)) -> bytes:
    buf = io.BytesIO()
    Image.new(mode, size, (200, 100, 50, 0) if mode == "CMYK" else (200, 100, 50)).save(
        buf, format="JPEG"
    )
    return buf.getvalue()


def _png_with_header(width: int, height: int) -> bytes:
    """A PNG whose IHDR claims `width`×`height` but whose pixels are 1×1."""
    real = _png(1, 1)
    ihdr = real.index(b"IHDR")
    return (real[:ihdr + 4] + width.to_bytes(4, "big") + height.to_bytes(4, "big")
            + real[ihdr + 12:])


# --------------------------------------------------------------------------- #
# Keys and refs
# --------------------------------------------------------------------------- #
def test_prefix_requires_a_principal():
    with pytest.raises(ValueError, match="requires a principal"):
        principal_prefix(None)


def test_prefix_is_derived_from_the_principal_kind(user, guest_session):
    session, _ = guest_session
    assert principal_prefix(user) == f"uploads/u/{user.pk}/"
    assert principal_prefix(session) == f"uploads/g/{session.pk}/"


@pytest.mark.parametrize("ref", ["", "short", "../../etc", "a b c d e f", "x" * 65])
def test_asset_key_refuses_a_ref_that_could_escape_the_prefix(user, ref):
    with pytest.raises(ImageRejected, match="invalid image ref"):
        asset_key(user, ref)


@pytest.mark.parametrize("ref", ["", "ab", "has/slash", None])
def test_source_key_refuses_a_bad_ref(user, ref):
    with pytest.raises(ImageRejected, match="invalid upload ref"):
        source_key(user, ref, "docx")


@pytest.mark.parametrize("ext", ["", "do cx", "tar.gz", "x" * 9, "exe!"])
def test_source_key_refuses_a_bad_extension(user, ext):
    with pytest.raises(ImageRejected, match="invalid file type"):
        source_key(user, "abcdef123456", ext)


def test_source_key_lowercases_and_strips_the_dot(user):
    assert source_key(user, "abcdef123456", ".DOCX").endswith("/abcdef123456.docx")


# --------------------------------------------------------------------------- #
# Header parsing: the decompression-bomb defence
# --------------------------------------------------------------------------- #
def test_png_header_dimensions_are_read_without_decoding():
    assert header_dimensions(_png(7, 3)) == (7, 3)


def test_jpeg_header_dimensions_are_read_from_the_sof_marker():
    assert header_dimensions(_jpeg(size=(9, 5))) == (9, 5)


def test_a_png_whose_first_chunk_is_not_ihdr_is_unreadable():
    data = _png()
    assert header_dimensions(data.replace(b"IHDR", b"IHDX", 1)) is None
    assert header_dimensions(b"\x89PNG\r\n\x1a\n" + b"\x00" * 4) is None


def test_a_jpeg_without_a_frame_header_is_unreadable():
    # SOI, then an APP0 segment that runs off the end of the data.
    truncated = b"\xff\xd8\xff\xe0\x00\x10JFIF"
    assert header_dimensions(truncated) is None
    # SOI then a segment with an impossible (<2) length.
    assert header_dimensions(b"\xff\xd8\xff\xe0\x00\x01" + b"\x00" * 8) is None
    # Padding bytes before a marker are skipped; a stray RST marker is stepped
    # over; with no SOF anywhere the answer is still None.
    assert header_dimensions(b"\xff\xd8\xff\xd0\x00\x00\xff\xd9\x00\x00") is None


def test_something_that_is_neither_png_nor_jpeg_has_no_dimensions():
    assert header_dimensions(b"GIF89a" + b"\x00" * 20) is None


# --------------------------------------------------------------------------- #
# normalize_png refusals
# --------------------------------------------------------------------------- #
def test_too_many_bytes_is_refused_before_sniffing():
    with pytest.raises(ImageRejected, match="2 MB or smaller"):
        normalize_png(b"\x00" * (2 * 1024 * 1024 + 1), max_bytes=2 * 1024 * 1024)


def test_a_non_image_is_refused_by_its_magic():
    with pytest.raises(ImageRejected, match="Only PNG and JPEG"):
        normalize_png(b"GIF89a" + b"\x00" * 64, max_bytes=1 << 20)


def test_a_png_with_an_unparseable_header_is_refused_without_decoding():
    data = _png().replace(b"IHDR", b"IHDX", 1)
    with patch("fitz.Pixmap") as pixmap:
        with pytest.raises(ImageRejected, match="could not be read"):
            normalize_png(data, max_bytes=1 << 20)
    pixmap.assert_not_called()


def test_a_header_claiming_too_many_pixels_is_refused_without_decoding():
    bomb = _png_with_header(40_000, 40_000)
    with patch("fitz.Pixmap") as pixmap:
        with pytest.raises(ImageRejected, match="too large"):
            normalize_png(bomb, max_bytes=1 << 20)
    pixmap.assert_not_called()


def test_a_header_claiming_zero_pixels_is_refused():
    with pytest.raises(ImageRejected, match="too large"):
        normalize_png(_png_with_header(0, 10), max_bytes=1 << 20)


def test_a_png_the_decoder_cannot_read_is_refused():
    data = _png()
    idat = data.index(b"IDAT")
    broken = data[:idat + 4] + b"\xff" * 8 + data[idat + 12:]
    with pytest.raises(ImageRejected, match="could not be read"):
        normalize_png(broken, max_bytes=1 << 20)


def test_a_lying_header_is_caught_after_decoding():
    """Header says 1×1, decoder says 8 000×8 000 — the post-decode check is
    the second line of defence and must still fire."""
    data = _png(1, 1)

    class Huge:
        width = 8_000
        height = 8_000
        colorspace = None

    with patch("fitz.Pixmap", return_value=Huge()):
        with pytest.raises(ImageRejected, match="too large"):
            normalize_png(data, max_bytes=1 << 20)


def test_a_cmyk_jpeg_is_converted_to_rgb_and_comes_out_as_png():
    png, width, height = normalize_png(_jpeg("CMYK", (6, 4)), max_bytes=1 << 20)
    assert (width, height) == (6, 4)
    assert png.startswith(b"\x89PNG\r\n\x1a\n")
    with Image.open(io.BytesIO(png)) as img:
        assert img.mode in ("RGB", "RGBA")
        assert img.size == (6, 4)


def test_an_rgb_jpeg_is_normalized_to_png_of_the_same_size():
    png, width, height = normalize_png(_jpeg("RGB", (5, 7)), max_bytes=1 << 20)
    assert (width, height) == (5, 7)
    assert png.startswith(b"\x89PNG\r\n\x1a\n")


# --------------------------------------------------------------------------- #
# store_image / store_source metering
# --------------------------------------------------------------------------- #
def test_store_image_refuses_when_the_quota_would_be_exceeded(user):
    tier = L.for_principal(user)
    type(user).objects.filter(pk=user.pk).update(storage_bytes_used=tier.storage_bytes - 1)
    user.refresh_from_db()
    storage = get_storage()
    with patch.object(storage, "put_bytes") as put:
        with pytest.raises(AssetQuotaExceeded) as info:
            store_image(user, _png())
    put.assert_not_called()
    assert info.value.quota == tier.storage_bytes
    assert info.value.used == tier.storage_bytes - 1
    user.refresh_from_db()
    assert user.storage_bytes_used == tier.storage_bytes - 1


def test_store_source_refuses_a_file_over_the_upload_cap(user):
    tiers = {**L.settings.TIERS, "free": {**L.settings.TIERS["free"], "max_upload_mb": 1}}
    data = b"<html><body>" + b"x" * (1024 * 1024 + 1) + b"</body></html>"
    with override_settings(TIERS=tiers):
        with pytest.raises(ImageRejected, match="1 MB or smaller"):
            store_source(user, data, "page.html")


def test_store_source_refuses_when_the_quota_would_be_exceeded(user):
    tier = L.for_principal(user)
    type(user).objects.filter(pk=user.pk).update(storage_bytes_used=tier.storage_bytes - 1)
    user.refresh_from_db()
    with pytest.raises(AssetQuotaExceeded) as info:
        store_source(user, b"<html><body>hi</body></html>", "page.html")
    assert info.value.used == tier.storage_bytes - 1


# --------------------------------------------------------------------------- #
# Listing helpers: one bad blob never stops the sweep
# --------------------------------------------------------------------------- #
def test_load_source_refuses_a_bad_ref(user):
    with pytest.raises(ImageRejected, match="invalid upload ref"):
        load_source(user, "../x")


def test_load_source_reports_a_ref_that_was_never_parked(user):
    with pytest.raises(ImageRejected, match="upload it again"):
        load_source(user, "abcdef123456")


def test_discard_source_ignores_a_bad_ref_and_deletes_nothing(user):
    storage = get_storage()
    with patch.object(storage, "delete") as delete:
        assert discard_source(user, "../x") == 0
    delete.assert_not_called()


def test_discard_source_refunds_the_full_size_only_when_head_works(user):
    parked = store_source(user, b"<html><body>hello</body></html>", "page.html")
    user.refresh_from_db()
    charged = user.storage_bytes_used
    assert charged > 0

    storage = get_storage()
    with patch.object(storage, "head", side_effect=OSError("no head")):
        assert discard_source(user, parked["ref"]) == 1
    user.refresh_from_db()
    # Head failed, so the size fell back to 0 and nothing was refunded — but
    # the blob is still gone and the call still counted it.
    assert user.storage_bytes_used == charged
    assert storage.list_prefix(principal_prefix(user)) == []


def test_discard_source_skips_a_blob_it_cannot_delete(user):
    parked = store_source(user, b"<html><body>hello</body></html>", "page.html")
    user.refresh_from_db()
    charged = user.storage_bytes_used

    storage = get_storage()
    with patch.object(storage, "delete", side_effect=OSError("locked")):
        assert discard_source(user, parked["ref"]) == 0
    user.refresh_from_db()
    assert user.storage_bytes_used == charged, "no refund for a blob still on disk"
    assert len(storage.list_prefix(principal_prefix(user))) == 1


def test_move_assets_skips_a_blob_it_cannot_read_and_moves_the_rest(user, other_user):
    first = store_image(user, _png())
    second = store_image(user, _png())
    storage = get_storage()
    bad_key = asset_key(user, first["ref"])
    real_get = storage.get_bytes

    def flaky_get(key):
        if key == bad_key:
            raise OSError("unreadable")
        return real_get(key)

    with patch.object(storage, "get_bytes", side_effect=flaky_get):
        moved = move_assets("u", user.pk, other_user)
    assert moved == 1
    assert storage.exists(asset_key(other_user, second["ref"]))
    assert not storage.exists(asset_key(other_user, first["ref"]))
    assert storage.exists(bad_key), "the unreadable blob is left where it was"


def test_load_images_skips_bad_refs_and_missing_blobs(user):
    stored = store_image(user, _png())
    out = load_images(user, [stored["ref"], "../evil", "", "missing_ref_12", None])
    assert set(out) == {stored["ref"]}
    assert out[stored["ref"]].startswith(b"\x89PNG")


def test_purge_principal_assets_returns_zero_when_storage_fails(user):
    storage = get_storage()
    with patch.object(storage, "delete_prefix", side_effect=OSError("down")):
        assert purge_principal_assets("u", user.pk) == 0


def test_sniff_recognizes_only_png_and_jpeg():
    assert assets.sniff(_png()) == "image/png"
    assert assets.sniff(_jpeg()) == "image/jpeg"
    assert assets.sniff(b"GIF89a") is None
    assert assets.sniff(b"") is None


def test_the_fixture_png_helper_agrees_with_pillow():
    """Guard the local helpers: a hand-rolled PNG that Pillow cannot open
    would make every refusal test above pass for the wrong reason."""
    with Image.open(io.BytesIO(_png(3, 2))) as img:
        assert img.size == (3, 2)
