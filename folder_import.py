"""Read a directory upload in a bounded, ordered stream."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import BinaryIO

from vault import MAX_ATTACHMENT, VaultError

MAX_IMPORT = 2 * 1024**3
MAX_MANIFEST = 4 * 1024**2
MAX_ENTRIES = 20_000


def read_exact(stream: BinaryIO, size: int) -> bytes:
    data = stream.read(size)
    if len(data) != size:
        raise VaultError("The folder transfer stopped. Try again.")
    return data


def valid_part(part: str) -> bool:
    return (0 < len(part) <= 255 and not part.startswith(".")
            and not any(char in part for char in "/\\")
            and all(ord(char) >= 32 for char in part))


def read_import(stream: BinaryIO, size: int) -> tuple[str, Iterator[tuple[str, bytes]]]:
    if not 4 < size <= MAX_IMPORT:
        raise VaultError("The folder can be up to 2 GiB.", 413)
    header_size = int.from_bytes(read_exact(stream, 4), "big")
    if not 0 < header_size <= min(MAX_MANIFEST, size - 4):
        raise VaultError("Could not read the folder manifest.")
    try:
        index = json.loads(read_exact(stream, header_size))
    except (ValueError, UnicodeError) as error:
        raise VaultError("Could not read the folder manifest.") from error
    if not isinstance(index, dict):
        raise VaultError("The folder manifest is invalid.")
    source, files = index.get("source"), index.get("files")
    if not isinstance(source, str) or not valid_part(source) or not isinstance(files, list) or not 1 <= len(files) <= MAX_ENTRIES:
        raise VaultError("Choose a folder containing 1–20,000 files.")

    paths: set[str] = set()
    entries: list[tuple[str, int]] = []
    for file in files:
        if not isinstance(file, list) or len(file) != 2:
            raise VaultError("Invalid file metadata.")
        path, length = file
        if not isinstance(path, str) or len(path) > 1800 or not all(valid_part(part) for part in path.split("/")):
            raise VaultError("The folder contains an invalid file path.")
        if path in paths or type(length) is not int or not 0 <= length <= MAX_ATTACHMENT:
            raise VaultError("The folder contains a duplicate path or a file larger than 64 MiB.")
        paths.add(path)
        entries.append((path, length))
    if size != 4 + header_size + sum(length for _, length in entries):
        raise VaultError("The folder size differs from the manifest.")

    def contents() -> Iterator[tuple[str, bytes]]:
        for path, length in entries:
            yield path, read_exact(stream, length)

    return source, contents()
