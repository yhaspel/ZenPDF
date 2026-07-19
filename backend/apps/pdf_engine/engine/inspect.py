"""inspect(bytes) -> metadata (phase 1)."""
from __future__ import annotations

import fitz

from ..exceptions import UnsupportedFileError


def inspect(data: bytes) -> dict:
    """Return {pages, size, encrypted, needs_password, metadata, toc}.

    Works on encrypted docs too: reports needs_password and leaves page/toc
    best-effort (0 / empty) when the content is locked.
    """
    try:
        doc = fitz.open(stream=data, filetype="pdf")
    except Exception as exc:  # noqa: BLE001
        raise UnsupportedFileError(f"Could not open PDF: {exc}") from exc

    try:
        needs_password = bool(doc.needs_pass)
        encrypted = bool(getattr(doc, "is_encrypted", False)) or needs_password
        pages = 0 if needs_password else doc.page_count
        metadata = dict(doc.metadata or {})
        toc = []
        if not needs_password:
            try:
                toc = [
                    {"level": lvl, "title": title, "page": page}
                    for lvl, title, page in doc.get_toc(simple=True)
                ]
            except Exception:  # noqa: BLE001
                toc = []
        return {
            "pages": pages,
            "size": len(data),
            "encrypted": encrypted,
            "needs_password": needs_password,
            "metadata": metadata,
            "toc": toc,
        }
    finally:
        doc.close()
