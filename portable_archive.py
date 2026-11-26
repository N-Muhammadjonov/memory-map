"""Create and safely recover the encrypted snapshot inside a portable ZIP."""

from __future__ import annotations

import os
import shutil
import sqlite3
import tempfile
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from vault import APPLICATION_ID, SCHEMA_VERSION, VaultError

SNAPSHOT = "xotira/vault.xotira"
MAX_SNAPSHOT = 32 * 1024**3


def restore_snapshot(portable: Path, destination: Path) -> None:
    if destination.exists() or destination.is_symlink():
        raise VaultError("Choose a new file name for the restored vault.")
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, name = tempfile.mkstemp(prefix=".recover-", dir=destination.parent)
    temporary = Path(name)
    try:
        try:
            with os.fdopen(descriptor, "wb") as target, ZipFile(portable) as archive:
                matching = [item for item in archive.infolist() if item.filename == SNAPSHOT]
                if len(matching) != 1 or not 0 < matching[0].file_size <= MAX_SNAPSHOT:
                    raise VaultError("No restorable vault found in the ZIP.")
                with archive.open(matching[0]) as source:
                    shutil.copyfileobj(source, target, length=1024**2)
                target.flush()
                os.fsync(target.fileno())
        except (BadZipFile, NotImplementedError, RuntimeError, EOFError) as error:
            raise VaultError("Could not read the restore archive.") from error
        try:
            with sqlite3.connect(temporary.as_uri() + "?mode=ro&immutable=1", uri=True) as database:
                database.execute("PRAGMA trusted_schema = OFF")
                if (database.execute("PRAGMA application_id").fetchone() != (APPLICATION_ID,)
                        or database.execute("PRAGMA user_version").fetchone() != (SCHEMA_VERSION,)
                        or database.execute("PRAGMA quick_check").fetchone() != ("ok",)
                        or database.execute("PRAGMA foreign_key_check").fetchone() is not None):
                    raise VaultError("The archived vault failed its integrity check.")
        except sqlite3.Error as error:
            raise VaultError("Could not read the archived vault.") from error
        try:
            os.link(temporary, destination)
        except FileExistsError as error:
            raise VaultError("Choose a new file name for the restored vault.") from error
    finally:
        temporary.unlink(missing_ok=True)
