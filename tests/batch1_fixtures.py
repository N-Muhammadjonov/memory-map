"""Build disposable golden records for the image and drawing workflow."""

from __future__ import annotations

import base64
import struct
import sys
import zlib
from pathlib import Path

from vault import Vault

PASSWORD = "xotira-disposable-browser-fixture"


def png(width: int = 1200, height: int = 720, ink: int = 30) -> bytes:
    """Generate a valid RGB PNG with a high-contrast 100 by 100 reference square."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    background = b"\xe3\xe8\xf1"
    accent = bytes((ink, 84, 170))
    start_x, start_y = (width - 100) // 2, (height - 100) // 2
    empty = bytes(1) + background * width
    square = bytes(1) + background * start_x + accent * 100 + background * (width - start_x - 100)
    pixels = empty * start_y + square * 100 + empty * (height - start_y - 100)
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")


def seed(vault: Vault) -> dict[str, str]:
    """Create image-only, mixed content, legacy drawing, note and map fixtures."""
    first, mixed, drawing = vault.create_notes([
        {"title": "Image only"},
        {"title": "Mixed image note"},
        {"title": "Drawing fixtures", "body": "Before drawing\n\nAfter drawing"},
    ])
    cover = vault.store_attachment(first, "Reference.png", png())
    left = vault.store_attachment(mixed, "One.png", png(720, 720, 60))
    right = vault.store_attachment(mixed, "Two.png", png(720, 1200, 95))
    legacy = vault.store_attachment(drawing, "Chizma-2025-01-01T09-00-00.png", png(720, 720))
    for note_id, title, body in [
        (first, "Image only", f"![Reference](attachment:{cover['id']})"),
        (mixed, "Mixed image note", f"Before 🧭\n\n![One](attachment:{left['id']})\n\n"
         "| Key | Value |\n| --- | --- |\n| A | B |\n\n```python\nprint(42)\n```\n\n"
         f"![Two](attachment:{right['id']})\n\nAfter"),
        (drawing, "Drawing fixtures", f"Before drawing\n\n![Legacy layout](attachment:{legacy['id']})\n\nAfter drawing"),
    ]:
        vault.update_note(note_id, {"revision": 1, "title": title, "body": body, "tags": []})
    note = vault.get_note(drawing)
    native = vault.create_drawing(drawing, {"revision": note["revision"], "offset": len(note["body"]),
        "image": base64.b64encode(png()).decode(), "strokes": [{"color": "#102030", "size": 4, "points": [[30, 50], [90, 50]]}]})
    vault.create_mind_map({"title": "Fixture map", "noteId": first})
    vault.create_notes([{"title": f"Overflow fixture {i} " + "W" * 90} for i in range(1, 7)])
    return {"first": first, "cover": cover["id"], "mixed": mixed, "drawing": drawing,
            "legacy": legacy["id"], "native": native["id"]}


if __name__ == "__main__":
    destination = Path(sys.argv[1]).resolve()
    if destination.exists():
        raise SystemExit("Choose a new path for the disposable fixture vault.")
    vault = Vault(destination)
    vault.unlock(PASSWORD, create=True)
    seed(vault)
    vault.lock()
