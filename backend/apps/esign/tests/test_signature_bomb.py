"""H3 — a signature image must not be able to OOM the API process.

`_open_image` counted pixels on the `Pixmap`, which is counting after the
allocation: a ~1.5 MB PNG declaring 40000×40000 is ~2.9 GB claimed before
anyone looks, in the API process, where §12's worker memory limits do not
apply. On Linux the OOM killer takes the process and leaves no exception to
catch. And the public ceremony's field-fill had no byte ceiling at all — the
one door into the normalizer with no account and no tier behind it.

The image-asset path has had the header guard since phase 3
(`apps/documents/tests/test_annotations_api.py`); these tests say the signature
path has it too.
"""
import base64
import time

import pytest
from django.core import mail

from apps.pdf_engine.engine import signatures as SG
from apps.pdf_engine.exceptions import InvalidParams

pytestmark = pytest.mark.django_db


def _png_bomb(width: int, height: int) -> bytes:
    """A tiny PNG that *decodes* to width×height.

    Same generator as the image-asset bomb test; kept local rather than
    imported across app boundaries.
    """
    import struct
    import zlib

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload)) + tag + payload
                + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)  # 8-bit greyscale
    compressor = zlib.compressobj(9)
    row = b"\x00" + b"\x00" * width
    parts = [compressor.compress(row) for _ in range(height)]
    parts.append(compressor.flush())
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", b"".join(parts)) + chunk(b"IEND", b""))


@pytest.fixture(scope="module")
def bomb() -> bytes:
    """Built once: the generator has to walk 1.6 G of scanlines to make it."""
    return _png_bomb(40000, 40000)


def _draw_png() -> bytes:
    import fitz

    doc = fitz.open()
    page = doc.new_page(width=300, height=120)
    page.draw_line((40, 80), (260, 50), width=3)
    data = page.get_pixmap(alpha=True).tobytes("png")
    doc.close()
    return data


def _data_url(data: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(data).decode()


# --------------------------------------------------------------------------- #
# The engine guard
# --------------------------------------------------------------------------- #
def test_the_bomb_is_small_enough_to_pass_every_byte_cap(bomb):
    """Which is the whole point of it: no size limit sees anything wrong."""
    assert len(bomb) < 2 * 1024 * 1024


def test_normalize_signature_refuses_the_bomb_from_its_header(bomb):
    started = time.monotonic()
    with pytest.raises(InvalidParams) as caught:
        SG.normalize_signature(bomb)
    elapsed = time.monotonic() - started

    assert "too large" in str(caught.value)
    # A refusal that arrives after the decode is not a refusal. Decoding 1.6 Gpx
    # takes many seconds and gigabytes; reading the IHDR takes microseconds.
    assert elapsed < 2.0, f"refused only after {elapsed:.1f}s — it decoded first"


def test_unreadable_bytes_are_refused_rather_than_handed_to_the_decoder():
    with pytest.raises(InvalidParams):
        SG.normalize_signature(b"this is not an image at all")


def test_an_ordinary_drawn_signature_still_normalizes():
    """The guard is only useful if it is not simply a wall."""
    out = SG.normalize_signature(_draw_png())
    assert out[:8] == b"\x89PNG\r\n\x1a\n"
    assert SG.png_size(out)[0] > 0


# --------------------------------------------------------------------------- #
# The two doors into the normalizer
# --------------------------------------------------------------------------- #
@pytest.fixture(autouse=True)
def _verified(user):
    user.email_verified = True
    user.save(update_fields=["email_verified"])
    return user


def test_the_account_signature_endpoint_refuses_the_bomb(api, bomb):
    resp = api.post("/api/signatures/",
                    {"kind": "signature", "method": "draw",
                     "image": _data_url(bomb)}, format="json")
    assert resp.status_code == 400, resp.content
    assert resp.json()["error"]["code"] == "validation_error"


@pytest.fixture
def ceremony(api, anon, uploaded_doc):
    """A sent request, consented, with the first signer's token and field id."""
    from apps.esign.models import Recipient

    created = api.post("/api/sign-requests/",
                       {"document": uploaded_doc["id"], "title": "Offer"},
                       format="json")
    assert created.status_code == 201, created.content
    request_id = created.json()["id"]

    people = api.patch(f"/api/sign-requests/{request_id}/",
                       {"recipients": [{"email": "signer@example.com",
                                        "name": "Sam", "role": "signer",
                                        "order": 1}]},
                       format="json").json()["recipients"]
    fields = api.patch(f"/api/sign-requests/{request_id}/",
                       {"fields": [{"recipient_id": people[0]["id"], "page": 0,
                                    "x": 0.1, "y": 0.7, "w": 0.3, "h": 0.08,
                                    "type": "signature", "required": True,
                                    "label": "Sign here"}]},
                       format="json").json()["fields_"]
    mail.outbox.clear()
    assert api.post(f"/api/sign-requests/{request_id}/send/",
                    format="json").status_code == 200
    token = Recipient.objects.get(sign_request_id=request_id,
                                  email="signer@example.com").token
    # Consent is checked ahead of the field content, so without it these tests
    # would prove nothing about the image guard.
    assert anon.get(f"/api/public/sign/{token}/").status_code == 200
    assert anon.post(f"/api/public/sign/{token}/consent/", {"agree": True},
                     format="json").status_code in (200, 201)
    return {"token": token, "field_id": fields[0]["id"]}


def _fill(anon, ceremony, image_data_url):
    return anon.post(f"/api/public/sign/{ceremony['token']}/fields/",
                     {"field_id": ceremony["field_id"],
                      "signature_image": image_data_url}, format="json")


def test_the_public_ceremony_refuses_the_bomb(anon, ceremony, bomb):
    """No account, no tier, no authentication — and a signing link is meant to
    be forwarded, so this is the door a stranger reaches."""
    resp = _fill(anon, ceremony, _data_url(bomb))
    assert resp.status_code == 400, resp.content
    assert resp.json()["error"]["code"] == "validation_error"


def test_the_public_ceremony_applies_a_byte_ceiling(anon, ceremony, monkeypatch):
    """The ceremony had no byte cap at all; the account path had one.

    The real ceiling is 12 MB, and today Django's own
    `DATA_UPLOAD_MAX_MEMORY_SIZE` (5 MB) shadows it — so the cap is exercised
    here at a lowered value, which is what proves the *check exists* on this
    path rather than that some other layer happens to be stricter right now.
    """
    from apps.esign import views

    png = _draw_png()
    monkeypatch.setattr(views, "MAX_SIGNATURE_IMAGE_BYTES", len(png) - 1)
    resp = _fill(anon, ceremony, _data_url(png))
    assert resp.status_code == 400, resp.content
    assert "too large" in resp.json()["error"]["message"]


def test_an_ordinary_signature_still_fills_the_field(anon, ceremony):
    resp = _fill(anon, ceremony, _data_url(_draw_png()))
    assert resp.status_code == 200, resp.content
    assert resp.json()["filled"] is True
