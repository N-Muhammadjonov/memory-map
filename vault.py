"""Encrypted note storage and portable backups for Xotira."""

from __future__ import annotations

import base64
import binascii
import errno
import hashlib
import hmac
import json
import os
import re
import sqlite3
import tempfile
import threading
import time
import unicodedata
from collections.abc import Callable, Iterator
from contextlib import closing, contextmanager
from dataclasses import asdict, dataclass, replace
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from entity_fields import LEGACY_FIELDS, NOTE_ID, clean_field
from graph_terms import attachment_terms, topic_terms
from import_frontmatter import frontmatter_names
from mind_map import encode_map, new_map
from vault_links import FENCE, LinkIndex, WIKILINK

try:  # POSIX (macOS, Linux)
    import fcntl
    msvcrt = None
except ImportError:  # Windows
    fcntl = None
    import msvcrt

from crypto_backend import InvalidTag
from crypto_backend import AESGCM
from crypto_backend import Argon2id

APPLICATION_ID = 0x584F5431
SCHEMA_VERSION = 1
LOCK_SECONDS = 600
MAX_BODY = 200_000
MAX_ATTACHMENT = 64 * 1024 * 1024
MAX_CANVAS = 8 * 1024 * 1024
MAX_DRAWING_PNG = 5 * 1024 * 1024
MAX_MARKUP = 768 * 1024
TASK_LINE = re.compile(r"^([ \t]*[-+*][ \t]+\[)([ xX])(\][ \t]+)([^\r\n]+)")
DRAWING_NAME = re.compile(r"Chizma-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-[a-f0-9]{8})?\.png\Z")
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
DRAWING_SCHEMA = """CREATE TABLE IF NOT EXISTS drawings (
    attachment_id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL, strokes BLOB NOT NULL, base BLOB
)"""
MARKUP_SCHEMA = """CREATE TABLE IF NOT EXISTS attachment_markup (
    attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    surface INTEGER NOT NULL, revision INTEGER NOT NULL, sealed BLOB NOT NULL,
    PRIMARY KEY (attachment_id, surface)
)"""
STRUCTURE_SCHEMA = (
    """CREATE TABLE IF NOT EXISTS entity_fields (
        note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, sealed BLOB NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS entity_history (
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, sealed BLOB NOT NULL, PRIMARY KEY (note_id, revision)
    )""",
    """CREATE TABLE IF NOT EXISTS legacy_entity_fields (
        note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE, sealed BLOB NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS note_history (
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, sealed BLOB NOT NULL, PRIMARY KEY (note_id, revision)
    )""",
)
SCHEMA = (
    "CREATE TABLE metadata (name TEXT PRIMARY KEY, value BLOB NOT NULL)",
    "CREATE TABLE notes (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, sealed BLOB NOT NULL)",
    """CREATE TABLE attachments (id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id),
                                 name BLOB NOT NULL, contents BLOB NOT NULL)""",
    "CREATE INDEX attachment_note ON attachments(note_id)",
    DRAWING_SCHEMA,
    MARKUP_SCHEMA,
    *STRUCTURE_SCHEMA,
)


class VaultError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Note:
    id: str
    revision: int
    title: str
    body: str
    tags: list[str]
    aliases: list[str]
    updated: str
    trashed: bool = False
    path: str = ""
    source: str = ""
    storage_only: bool = False


def clean_title(value: str) -> str:
    title = " ".join(value.split())
    if not title or len(title) > 120 or any(char in title for char in "[]#|"):
        raise VaultError("Enter a title with 1–120 characters. Remove [ ] # | from the title.")
    return title


def title_key(value: str) -> str:
    return unicodedata.normalize("NFKC", value).strip().casefold()


def vault_key(password: str, salt: bytes) -> bytes:
    return Argon2id(salt=salt, length=32, iterations=3, lanes=4, memory_cost=65536).derive(
        password.encode("utf-8")
    )


def vault_cipher(password: str, salt: bytes) -> AESGCM:
    return AESGCM(vault_key(password, salt))


def seal(cipher: AESGCM, data: bytes, context: bytes) -> bytes:
    nonce = os.urandom(12)
    return nonce + cipher.encrypt(nonce, data, context)


def unseal(cipher: AESGCM, data: bytes, context: bytes) -> bytes:
    return cipher.decrypt(data[:12], data[12:], context)


def note_body(value: Any) -> str:
    if not isinstance(value, str) or len(value) > MAX_BODY:
        raise VaultError(f"A note can contain up to {MAX_BODY:,} characters.")
    return value


def note_tags(values: Any) -> list[str]:
    if not isinstance(values, list) or len(values) > 12:
        raise VaultError("A note can contain up to 12 tags.")
    tags: dict[str, str] = {}
    for value in values:
        if not isinstance(value, str) or len(value) > 36:
            raise VaultError("A tag can be up to 36 characters.")
        tag = " ".join(value.split()).lstrip("#")
        if tag:
            tags.setdefault(title_key(tag), tag)
    return list(tags.values())


def map_unfenced_lines(body: str, transform: Callable[[str], str]) -> str:
    lines: list[str] = []
    marker = ""
    for line in body.splitlines(keepends=True):
        opening = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
        if opening:
            token = opening.group(1)
            if not marker:
                marker = token
            elif token.startswith(marker) and not line[opening.end():].strip():
                marker = ""
            lines.append(line)
        elif marker:
            lines.append(line)
        else:
            lines.append(transform(line))
    return "".join(lines)


def map_wikilinks(body: str, replace: Callable[[re.Match[str]], str]) -> str:
    def transform(line: str) -> str:
        parts = re.split(r"(`+[^`\n]*`+)", line)
        parts[::2] = [WIKILINK.sub(replace, part) for part in parts[::2]]
        return "".join(parts)

    return map_unfenced_lines(body, transform)


def file_metadata(raw: bytes) -> dict[str, Any]:
    if raw.startswith(b"\x00"):
        return json.loads(raw[1:])
    name = raw.decode("utf-8")
    return {"name": name, **({"drawing": True} if DRAWING_NAME.fullmatch(name) else {})}


def drawing_content(item: dict[str, Any]) -> tuple[bytes, bytes]:
    encoded = item.get("image")
    if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_DRAWING_PNG + 2) // 3):
        raise VaultError("Invalid drawing image size or format.")
    try:
        image = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as error:
        raise VaultError("Could not read the drawing image.") from error
    if len(image) < 33 or len(image) > MAX_DRAWING_PNG or not image.startswith(PNG_SIGNATURE) or image[12:16] != b"IHDR":
        raise VaultError("The drawing image must use PNG format.")
    if not all(0 < int.from_bytes(image[start:start + 4], "big") <= 2000 for start in (16, 20)):
        raise VaultError("Invalid drawing dimensions.")
    strokes = item.get("strokes")
    if not isinstance(strokes, list) or len(strokes) > 4000:
        raise VaultError("The drawing strokes are invalid.")
    total = 0
    for stroke in strokes:
        if (not isinstance(stroke, dict) or set(stroke) != {"color", "size", "points"}
                or not isinstance(stroke["color"], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", stroke["color"])
                or type(stroke["size"]) not in (int, float) or not 1 <= stroke["size"] <= 40
                or not isinstance(stroke["points"], list) or not stroke["points"]):
            raise VaultError("Invalid drawing stroke.")
        total += len(stroke["points"])
        if total > 30_000:
            raise VaultError("A drawing can contain up to 30,000 points.")
        for point in stroke["points"]:
            if (not isinstance(point, list) or len(point) != 2
                    or any(type(value) not in (int, float) or not 0 <= value <= 2000 for value in point)):
                raise VaultError("Invalid drawing point.")
    return image, json.dumps(strokes, separators=(",", ":")).encode()


def markup_content(marks: Any) -> bytes:
    def valid_point(point: Any) -> bool:
        return (isinstance(point, list) and len(point) == 2
                and all(type(value) in (float, int) and 0 <= value <= 1 for value in point))

    if not isinstance(marks, list) or len(marks) > 300:
        raise VaultError("Use at most 300 annotations per page.")
    point_count = 0
    for mark in marks:
        if not isinstance(mark, dict):
            raise VaultError("Invalid annotation.")
        kind, color, size = mark.get("kind"), mark.get("color"), mark.get("size")
        if (not isinstance(color, str) or not re.fullmatch(r"#[a-fA-F0-9]{6}", color)
                or type(size) is not int or not 1 <= size <= 64):
            raise VaultError("Invalid annotation style.")
        if kind == "text" and mark.keys() == {"kind", "color", "size", "point", "text"}:
            text = mark["text"]
            if not valid_point(mark["point"]) or not isinstance(text, str) or not text.strip() or len(text) > 500:
                raise VaultError("Use 1–500 characters for annotation text.")
        elif kind in ("ink", "highlight") and mark.keys() == {"kind", "color", "size", "points"}:
            points = mark["points"]
            if not isinstance(points, list) or not 1 <= len(points) <= 3000 or not all(map(valid_point, points)):
                raise VaultError("Invalid annotation stroke.")
            point_count += len(points)
        else:
            raise VaultError("Invalid annotation tool.")
    if point_count > 20_000:
        raise VaultError("Use at most 20,000 drawing points per page.")
    data = json.dumps(marks, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(data) > MAX_MARKUP:
        raise VaultError("The page annotations are too large.", 413)
    return data


class Vault:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.cipher: AESGCM | None = None
        self._master_key = b""
        self.vault_id = b""
        self.notes: dict[str, Note] = {}
        self.unlocked_notes: set[str] = set()
        self.topic_cache: dict[str, tuple[int, list[str]]] = {}
        self.entities: dict[str, dict[str, Any]] = {}
        self.last_activity = 0.0
        self.unpublished_hook = None
        self._passive = threading.local()
        self.next_unlock = 0.0
        self.changes = 0
        self.search_cache: tuple[int, Any] | None = None

    @property
    def exists(self) -> bool:
        return self.path.is_file()

    @contextmanager
    def connection(self, create: bool = False) -> Iterator[sqlite3.Connection]:
        mode = "rwc" if create else "rw"
        database = sqlite3.connect(f"{self.path.as_uri()}?mode={mode}", uri=True, timeout=3)
        try:
            database.execute("PRAGMA trusted_schema = OFF")
            database.execute("PRAGMA foreign_keys = ON")
            database.execute("PRAGMA synchronous = FULL")
            database.execute("PRAGMA fullfsync = ON")
            yield database
        finally:
            database.close()

    @contextmanager
    def process_lock(self) -> Iterator[None]:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        lock_path = self.path.with_suffix(self.path.suffix + ".lock")
        flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
        descriptor = os.open(lock_path, flags, 0o600)
        locked = False
        try:
            try:
                if fcntl is not None:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                else:  # Windows: lock the first byte of the lock file
                    msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
                locked = True
            except OSError as error:  # BlockingIOError on POSIX, PermissionError/OSError on Windows
                raise VaultError("Another Memory map window already has this vault open.") from error
            yield
        finally:
            if locked and fcntl is None:
                try:
                    msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
                except OSError:
                    pass
            os.close(descriptor)

    def status(self) -> dict[str, bool]:
        if self.cipher is not None and time.monotonic() - self.last_activity >= LOCK_SECONDS:
            self.lock()
        return {"exists": self.exists, "unlocked": self.cipher is not None}

    def require_unlocked(self, *, touch: bool = True) -> AESGCM:
        if not self.status()["unlocked"] or self.cipher is None:
            raise VaultError("The vault is locked. Enter your password again.", 423)
        if touch and not getattr(self._passive, "on", False):
            self.last_activity = time.monotonic()
        return self.cipher

    @contextmanager
    def passive(self) -> Iterator[None]:
        # Requests made inside this block never extend the idle-lock timer.
        previous = getattr(self._passive, "on", False)
        self._passive.on = True
        try:
            yield
        finally:
            self._passive.on = previous

    @contextmanager
    def ai_scope(self) -> Iterator[None]:
        previous = getattr(self._passive, "ai", False)
        self._passive.ai = True
        try:
            yield
        finally:
            self._passive.ai = previous

    @property
    def ai_scoped(self) -> bool:
        return getattr(self._passive, "ai", False)

    def lock(self) -> None:
        self.cipher = None
        self._master_key = b""
        self.notes.clear()
        self.unlocked_notes.clear()
        self.topic_cache.clear()
        self.entities.clear()
        self.search_cache = None
        self.vault_id = b""

    def _context(self, purpose: str, record: str = "", revision: int = 0) -> bytes:
        return b"Xotira/1/" + self.vault_id + f"/{purpose}/{record}/{revision}".encode("ascii")

    def unlock(self, password: Any, *, create: bool) -> None:
        if not isinstance(password, str) or not password or len(password) > 512:
            raise VaultError("Enter a password of up to 512 characters.")
        self.status()
        if time.monotonic() < self.next_unlock:
            raise VaultError("Wait a few seconds before trying again.", 429)
        if create:
            if self.exists:
                raise VaultError("This vault already exists.", 409)
            if len(password) < 12:
                raise VaultError("Use at least 12 characters for the new password.")
            self._create(password)
            return
        if not self.exists:
            raise VaultError("Vault file not found.", 404)
        try:
            with self.connection() as database:
                app_id = database.execute("PRAGMA application_id").fetchone()[0]
                version = database.execute("PRAGMA user_version").fetchone()[0]
                if app_id != APPLICATION_ID or version != SCHEMA_VERSION:
                    raise VaultError("This version cannot open the vault format.")
                metadata = dict(database.execute("SELECT name, value FROM metadata"))
                salt = metadata["salt"]
                vault_id = metadata["vault_id"]
                if len(salt) != 16 or len(vault_id) != 16:
                    raise VaultError("The vault header is damaged.")
                key = vault_key(password, salt)
                cipher = AESGCM(key)
                proof = unseal(cipher, metadata["proof"], b"Xotira/1/proof/" + vault_id)
                if proof != b"xotira-vault":
                    raise InvalidTag()
                notes = {}
                for note_id, revision, encrypted in database.execute(
                    "SELECT id, revision, sealed FROM notes"
                ):
                    context = b"Xotira/1/" + vault_id + f"/note/{note_id}/{revision}".encode("ascii")
                    notes[note_id] = Note(
                        id=note_id, revision=revision,
                        **json.loads(unseal(cipher, encrypted, context)),
                    )
        except InvalidTag as error:
            self.next_unlock = time.monotonic() + 2
            raise VaultError("The password is incorrect or the vault file is damaged.", 403) from error
        except (sqlite3.DatabaseError, KeyError, ValueError, TypeError) as error:
            raise VaultError("Could not read the vault. Try restoring a backup.") from error
        with self.connection() as database:
            tables = {row[0] for row in database.execute("SELECT name FROM sqlite_schema WHERE type = 'table'")}
        if not {"entity_fields", "entity_history", "note_history", "legacy_entity_fields"}.issubset(tables):
            snapshot = self.path.with_name(self.path.name + ".pre-structure-" + uuid4().hex[:8] + ".xotira")
            self.backup(snapshot)
            with self.connection() as database, database:
                database.execute("BEGIN IMMEDIATE")
                for statement in STRUCTURE_SCHEMA:
                    database.execute(statement)
        with self.connection() as database, database:
            database.execute(DRAWING_SCHEMA)
            database.execute(MARKUP_SCHEMA)
            entities = {}
            for note_id, revision, encrypted in database.execute("SELECT note_id, revision, sealed FROM entity_fields"):
                context = b"Xotira/1/" + vault_id + f"/entity/{note_id}/{revision}".encode("ascii")
                try:
                    fields = json.loads(unseal(cipher, encrypted, context))
                    if not isinstance(fields, dict):
                        raise ValueError("Invalid stored fields")
                    fields = {name: clean_field(name, value) for name, value in fields.items()}
                except (InvalidTag, ValueError, TypeError) as error:
                    self.lock()
                    raise VaultError("Note properties are damaged. Check the encrypted backup.") from error
                entities[note_id] = {"revision": revision, "fields": fields}
        self.vault_id, self.cipher, self._master_key, self.notes, self.entities = vault_id, cipher, key, notes, entities
        self.last_activity = time.monotonic()
        from ai_providers import compact, migrate

        try:
            migrate(self)
            compact(self)
        except (OSError, VaultError, InvalidTag, sqlite3.Error, ValueError):
            # The vault remains usable. AI settings report credential storage errors.
            pass

    def _create(self, password: str) -> None:
        salt, vault_id = os.urandom(16), os.urandom(16)
        key = vault_key(password, salt)
        cipher = AESGCM(key)
        proof = seal(cipher, b"xotira-vault", b"Xotira/1/proof/" + vault_id)
        descriptor, temporary = tempfile.mkstemp(prefix=".new-", dir=self.path.parent)
        os.close(descriptor)
        temporary_path = Path(temporary)
        try:
            with closing(sqlite3.connect(temporary_path)) as database, database:
                database.execute("PRAGMA synchronous = FULL")
                database.execute("PRAGMA fullfsync = ON")
                database.execute("BEGIN IMMEDIATE")
                for statement in SCHEMA:
                    database.execute(statement)
                database.execute(f"PRAGMA application_id = {APPLICATION_ID}")
                database.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
                database.executemany(
                    "INSERT INTO metadata (name, value) VALUES (?, ?)",
                    (("salt", salt), ("vault_id", vault_id), ("proof", proof)),
                )
            os.link(temporary_path, self.path)
        except FileExistsError as error:
            raise VaultError("This vault already exists.", 409) from error
        finally:
            temporary_path.unlink(missing_ok=True)
        self.vault_id, self.cipher, self._master_key = vault_id, cipher, key
        self.last_activity = time.monotonic()

    def has_recovery_key(self) -> bool:
        self.require_unlocked(touch=False)
        with self.connection() as database:
            row = database.execute("SELECT 1 FROM metadata WHERE name = 'recovery_wrapped'").fetchone()
        return row is not None

    def generate_recovery_key(self) -> str:
        self.require_unlocked()
        if not self._master_key:
            raise VaultError("Unlock the vault with your password first.")
        raw = base64.b32encode(os.urandom(20)).decode("ascii")
        formatted = "-".join(raw[i:i + 4] for i in range(0, len(raw), 4))
        normalized = raw.upper()
        rec_salt = os.urandom(16)
        rec_cipher = vault_cipher(normalized, rec_salt)
        wrapped = seal(rec_cipher, self._master_key, b"Xotira/1/recovery/" + self.vault_id)
        with self.connection() as database, database:
            database.executemany(
                "INSERT OR REPLACE INTO metadata (name, value) VALUES (?, ?)",
                (("recovery_salt", rec_salt), ("recovery_wrapped", wrapped)),
            )
        self.changes += 1
        return formatted

    def unlock_with_recovery(self, recovery_key: Any, new_password: Any) -> None:
        if not isinstance(recovery_key, str) or not 1 <= len(recovery_key) <= 256 or not recovery_key.strip():
            raise VaultError("Enter your recovery key.")
        if not isinstance(new_password, str) or len(new_password) < 12 or len(new_password) > 512:
            raise VaultError("Use at least 12 characters for the new password.")
        self.status()
        if time.monotonic() < self.next_unlock:
            raise VaultError("Wait a few seconds before trying again.", 429)
        if not self.exists:
            raise VaultError("Vault file not found.", 404)
        normalized = re.sub(r"[\s-]+", "", recovery_key).upper()
        if not re.fullmatch(r"[A-Z2-7]{32}", normalized):
            raise VaultError("Enter the complete recovery key.")
        try:
            with self.connection() as database:
                app_id = database.execute("PRAGMA application_id").fetchone()[0]
                version = database.execute("PRAGMA user_version").fetchone()[0]
                if app_id != APPLICATION_ID or version != SCHEMA_VERSION:
                    raise VaultError("This version cannot open the vault format.")
                metadata = dict(database.execute("SELECT name, value FROM metadata"))
                vault_id = metadata["vault_id"]
                rec_salt = metadata.get("recovery_salt")
                rec_wrapped = metadata.get("recovery_wrapped")
                if not rec_salt or not rec_wrapped or len(rec_salt) != 16 or len(vault_id) != 16:
                    raise VaultError("No recovery key is configured for this vault.", 404)
                rec_cipher = vault_cipher(normalized, rec_salt)
                old_key = unseal(rec_cipher, rec_wrapped, b"Xotira/1/recovery/" + vault_id)
                old_cipher = AESGCM(old_key)
                if unseal(old_cipher, metadata["proof"], b"Xotira/1/proof/" + vault_id) != b"xotira-vault":
                    raise InvalidTag()
                new_salt = os.urandom(16)
                new_key = vault_key(new_password, new_salt)
                new_cipher = AESGCM(new_key)
                new_proof = seal(new_cipher, b"xotira-vault", b"Xotira/1/proof/" + vault_id)
                rekey_meta = []
                for name, value in metadata.items():
                    if name in {"salt", "vault_id", "proof", "recovery_salt", "recovery_wrapped"}:
                        continue
                    plain = unseal(old_cipher, value, b"Xotira/1/" + vault_id + f"/{name}//0".encode("ascii"))
                    rekey_meta.append((name, seal(new_cipher, plain, b"Xotira/1/" + vault_id + f"/{name}//0".encode("ascii"))))
                rekey_notes = [(nid, rev, seal(new_cipher, unseal(old_cipher, enc, b"Xotira/1/" + vault_id + f"/note/{nid}/{rev}".encode("ascii")), b"Xotira/1/" + vault_id + f"/note/{nid}/{rev}".encode("ascii")))
                               for nid, rev, enc in database.execute("SELECT id, revision, sealed FROM notes")]
                rekey_note_hist = [(nid, rev, seal(new_cipher, unseal(old_cipher, enc, b"Xotira/1/" + vault_id + f"/note/{nid}/{rev}".encode("ascii")), b"Xotira/1/" + vault_id + f"/note/{nid}/{rev}".encode("ascii")))
                                   for nid, rev, enc in database.execute("SELECT note_id, revision, sealed FROM note_history")]
                rekey_att = [(aid, nid, seal(new_cipher, unseal(old_cipher, nm, b"Xotira/1/" + vault_id + f"/filename/{nid + aid}/0".encode("ascii")), b"Xotira/1/" + vault_id + f"/filename/{nid + aid}/0".encode("ascii")),
                              seal(new_cipher, unseal(old_cipher, ct, b"Xotira/1/" + vault_id + f"/attachment/{nid + aid}/0".encode("ascii")), b"Xotira/1/" + vault_id + f"/attachment/{nid + aid}/0".encode("ascii")))
                             for aid, nid, nm, ct in database.execute("SELECT id, note_id, name, contents FROM attachments")]
                att_map = {aid: nid for aid, nid, _, _ in rekey_att}
                rekey_draw = [(aid, rev, seal(new_cipher, unseal(old_cipher, st, b"Xotira/1/" + vault_id + f"/drawing/{att_map[aid] + aid}/{rev}".encode("ascii")), b"Xotira/1/" + vault_id + f"/drawing/{att_map[aid] + aid}/{rev}".encode("ascii")),
                               seal(new_cipher, unseal(old_cipher, bs, b"Xotira/1/" + vault_id + f"/drawing-base/{att_map[aid] + aid}/0".encode("ascii")), b"Xotira/1/" + vault_id + f"/drawing-base/{att_map[aid] + aid}/0".encode("ascii")) if bs else None)
                              for aid, rev, st, bs in database.execute("SELECT attachment_id, revision, strokes, base FROM drawings")]
                rekey_ent = [(nid, rev, seal(new_cipher, unseal(old_cipher, enc, b"Xotira/1/" + vault_id + f"/entity/{nid}/{rev}".encode("ascii")), b"Xotira/1/" + vault_id + f"/entity/{nid}/{rev}".encode("ascii")))
                             for nid, rev, enc in database.execute("SELECT note_id, revision, sealed FROM entity_fields")]
                rekey_ent_hist = [(nid, rev, seal(new_cipher, unseal(old_cipher, enc, b"Xotira/1/" + vault_id + f"/entity/{nid}/{rev}".encode("ascii")), b"Xotira/1/" + vault_id + f"/entity/{nid}/{rev}".encode("ascii")))
                                  for nid, rev, enc in database.execute("SELECT note_id, revision, sealed FROM entity_history")]
                rekey_leg = [(nid, seal(new_cipher, unseal(old_cipher, enc, b"Xotira/1/" + vault_id + f"/legacy-entity/{nid}/0".encode("ascii")), b"Xotira/1/" + vault_id + f"/legacy-entity/{nid}/0".encode("ascii")))
                             for nid, enc in database.execute("SELECT note_id, sealed FROM legacy_entity_fields")]
                from ai_providers import rekey

                try:
                    rekey(self.path, vault_id, old_cipher, new_cipher)
                except (OSError, VaultError):
                    # A broken AI sidecar cannot prevent recovery of the notes vault.
                    pass
                with database:
                    database.execute("BEGIN IMMEDIATE")
                    database.execute(MARKUP_SCHEMA)
                    for attachment_id, surface, revision, encrypted in database.execute(
                        "SELECT attachment_id, surface, revision, sealed FROM attachment_markup"
                    ):
                        ident = att_map[attachment_id] + attachment_id
                        context = b"Xotira/1/" + vault_id + f"/file-markup.{surface}/{ident}/{revision}".encode("ascii")
                        updated = seal(new_cipher, unseal(old_cipher, encrypted, context), context)
                        database.execute("UPDATE attachment_markup SET sealed = ? WHERE attachment_id = ? AND surface = ?",
                                         (updated, attachment_id, surface))
                    database.execute("DELETE FROM metadata WHERE name IN ('recovery_salt', 'recovery_wrapped')")
                    database.executemany("INSERT OR REPLACE INTO metadata VALUES (?, ?)", [("salt", new_salt), ("proof", new_proof), *rekey_meta])
                    database.executemany("UPDATE notes SET sealed = ? WHERE id = ? AND revision = ?", [(s, nid, rev) for nid, rev, s in rekey_notes])
                    database.executemany("UPDATE note_history SET sealed = ? WHERE note_id = ? AND revision = ?", [(s, nid, rev) for nid, rev, s in rekey_note_hist])
                    database.executemany("UPDATE attachments SET name = ?, contents = ? WHERE id = ? AND note_id = ?", [(nm, ct, aid, nid) for aid, nid, nm, ct in rekey_att])
                    database.executemany("UPDATE drawings SET strokes = ?, base = ? WHERE attachment_id = ?", [(st, bs, aid) for aid, _, st, bs in rekey_draw])
                    database.executemany("UPDATE entity_fields SET sealed = ? WHERE note_id = ? AND revision = ?", [(s, nid, rev) for nid, rev, s in rekey_ent])
                    database.executemany("UPDATE entity_history SET sealed = ? WHERE note_id = ? AND revision = ?", [(s, nid, rev) for nid, rev, s in rekey_ent_hist])
                    database.executemany("UPDATE legacy_entity_fields SET sealed = ? WHERE note_id = ?", [(s, nid) for nid, s in rekey_leg])
        except InvalidTag as error:
            self.next_unlock = time.monotonic() + 2
            raise VaultError("The recovery key is incorrect or the vault is damaged.", 403) from error
        except VaultError:
            raise
        except (sqlite3.DatabaseError, KeyError, ValueError, TypeError) as error:
            raise VaultError("Could not recover the vault. Try restoring a backup.") from error
        self.unlock(new_password, create=False)

    def _topic_terms(self, note: Note) -> list[str]:
        cached = self.topic_cache.get(note.id)
        if cached is None or cached[0] != note.revision:
            cached = (note.revision, topic_terms(note.body))
            self.topic_cache[note.id] = cached
        return cached[1]

    def graph(self, query: str = "", trash: bool = False) -> dict[str, Any]:
        self.require_unlocked()
        locked_ids = self.locked_note_ids()
        active = [replace(note, body="") if note.id in locked_ids else note
                  for note in self.notes.values() if not note.storage_only and note.trashed == trash]
        files = self.list_attachments(trash)
        index = LinkIndex(active, files, title_key)
        nodes = [
            {"id": note.id, "title": note.title, "tags": note.tags, "path": note.path, "source": note.source,
             "aliases": note.aliases, "updated": note.updated,
             "entity": {"revision": 0, "fields": {}} if note.id in locked_ids else self.entity(note.id)}
            for note in sorted(active, key=lambda note: note.updated, reverse=True)
        ]
        edges: list[list[str]] = []
        relationships = [] if trash else [r for r in self.relationships(active) if r["source"] not in locked_ids]
        if not trash:
            for note in active:
                targets = set(index.links_for(note).values()) | index.attached[note.id]
                edges.extend([note.id, target] for target in sorted(targets - {note.id}))
            active_ids = {note.id for note in active}
            for file in files:
                edges.extend([file["id"], ref] for ref in file.get("mapRefs", []) if ref in active_ids)
            pairs = {tuple(edge) for edge in edges}
            for item in relationships:
                pair = (item["source"], item["target"])
                if pair not in pairs:
                    pairs.add(pair)
                    edges.append(list(pair))
        keys = title_key(query).split()
        hits = []
        if keys:
            for note in active:
                content = title_key(" ".join((note.title, note.source, note.path, *note.tags, *note.aliases,
                                             *[str(value) for value in ({} if note.id in locked_ids else self.entity(note.id)["fields"]).values()
                                               if isinstance(value, str)], note.body)))
                if all(part in content for part in keys):
                    hits.append(note.id)
            for file in files:
                content = title_key(" ".join((file["name"], file.get("mapTitle", ""), file.get("path", ""), file["noteTitle"])))
                if all(part in content for part in keys):
                    hits.append(file["id"])
        positions = self.graph_positions() if not trash else {}
        pinned = self.pinned_notes() if not trash else set()
        for item in nodes:
            note_obj = self.notes[item["id"]]
            locked = item["id"] in locked_ids
            item["locked"] = locked
            item["pinned"] = item["id"] in pinned
            item["words"] = 0 if locked else len(note_obj.body.split())
            item["topicTerms"] = [] if locked else self._topic_terms(note_obj)
            if locked:
                item["preview"] = ""
            else:
                clean = re.sub(r"^---[\s\S]*?---\s*", "", note_obj.body, count=1)
                clean = re.sub(r"[#*_~`>\[\]]", "", clean)
                clean = re.sub(r"\s+", " ", clean).strip()
                item["preview"] = clean[:180] + ("…" if len(clean) > 180 else "")
        return {"nodes": nodes, "files": files, "edges": edges, "hits": hits, "positions": positions,
                "relationships": relationships}

    def entity(self, note_id: str) -> dict[str, Any]:
        return self.entities.get(note_id, {"revision": 0, "fields": {}})

    def relationships(self, notes: list[Note]) -> list[dict[str, str]]:
        active = {note.id for note in notes}
        return [
            {"source": note.id, **relation}
            for note in notes
            for relation in self.entity(note.id)["fields"].get("relationships", [])
            if relation["target"] in active
        ]

    def _entity_note(self, note_id: str) -> Note:
        note = self.notes.get(note_id)
        if note is None or note.storage_only:
            raise VaultError("Note not found.", 404)
        return note

    def _store_entity(self, database: sqlite3.Connection, cipher: AESGCM, note_id: str,
                      revision: int, fields: dict[str, Any]) -> dict[str, Any]:
        database.execute(
            """INSERT INTO entity_history SELECT note_id, revision, sealed FROM entity_fields
               WHERE note_id = ?""", (note_id,),
        )
        encrypted = seal(cipher, json.dumps(fields, ensure_ascii=False).encode("utf-8"),
                         self._context("entity", note_id, revision))
        database.execute(
            """INSERT INTO entity_fields VALUES (?, ?, ?) ON CONFLICT(note_id) DO UPDATE
               SET revision = excluded.revision, sealed = excluded.sealed""",
            (note_id, revision, encrypted),
        )
        return {"revision": revision, "fields": fields}

    def update_entity(self, note_id: str, expected: Any, patch: Any, *,
                      replace_fields: bool = False) -> dict[str, Any]:
        cipher = self.require_unlocked()
        note = self._entity_note(note_id)
        self.require_note_unlocked(note_id)
        if note.trashed:
            raise VaultError("Restore the note to edit its properties.", 409)
        current = self.entity(note_id)
        if type(expected) is not int or expected != current["revision"]:
            raise VaultError("Properties changed in another window. Try again.", 409)
        if not isinstance(patch, dict):
            raise VaultError("Invalid note properties.")
        try:
            changes = {name: clean_field(name, value) for name, value in patch.items()}
        except (ValueError, TypeError) as error:
            raise VaultError("Invalid property value or relationship type.") from error
        prior_relations = {(item["type"], item["target"])
                           for item in current["fields"].get("relationships", [])}
        for relation in changes.get("relationships", []):
            target = self.notes.get(relation["target"])
            if (target is None or target.storage_only or target.id == note_id) and (
                    relation["type"], relation["target"]) not in prior_relations:
                raise VaultError("Choose another existing note to link.")
        fields = changes if replace_fields else {**current["fields"], **changes}
        if fields == current["fields"]:
            return current
        with self.connection() as database, database:
            data = self._store_entity(database, cipher, note_id, expected + 1, fields)
        self.entities[note_id] = data
        self.changes += 1
        return data

    def migrate_legacy_entities(self, records: Any) -> dict[str, int]:
        cipher = self.require_unlocked()
        if not isinstance(records, dict) or len(records) > 100_000:
            raise VaultError("The legacy properties file is invalid.")
        counts = dict(updated=0, unchanged=0, conflicts=0, invalid=0, missing=0)
        updated: dict[str, dict[str, Any]] = {}
        receipts_changed = False
        with self.connection() as database, database:
            receipts = dict(database.execute("SELECT note_id, sealed FROM legacy_entity_fields"))
            for note_id, record in records.items():
                if not isinstance(note_id, str) or not NOTE_ID.fullmatch(note_id) or not isinstance(record, dict):
                    counts["invalid"] += 1
                    continue
                note = self.notes.get(note_id)
                if note is None or note.storage_only:
                    counts["missing"] += 1
                    continue
                current = self.entity(note_id)
                fields = dict(current["fields"])
                context = self._context("legacy-entity", note_id)
                received = set(json.loads(unseal(cipher, receipts[note_id], context))) if note_id in receipts else set()
                original_receipt = received.copy()
                for name, value in record.items():
                    if name not in LEGACY_FIELDS:
                        counts["invalid"] += 1
                        continue
                    try:
                        value = clean_field(name, value)
                    except (ValueError, TypeError):
                        counts["invalid"] += 1
                        continue
                    if name in fields and fields[name] != value:
                        counts["conflicts"] += 1
                    if name not in received:
                        fields.setdefault(name, value)
                    received.add(name)
                if received != original_receipt:
                    sealed = seal(cipher, json.dumps(sorted(received)).encode("utf-8"), context)
                    database.execute("INSERT OR REPLACE INTO legacy_entity_fields VALUES (?, ?)", (note_id, sealed))
                    receipts_changed = True
                if fields == current["fields"]:
                    counts["unchanged"] += 1
                    continue
                updated[note_id] = self._store_entity(database, cipher, note_id, current["revision"] + 1, fields)
                counts["updated"] += 1
        if updated or receipts_changed:
            self.entities.update(updated)
            self.changes += 1
        return counts

    def history(self, note_id: str, kind: str, revision: int | None = None) -> dict[str, Any]:
        cipher = self.require_unlocked()
        note = self._entity_note(note_id)
        self.require_note_unlocked(note_id)
        table, purpose = ("note_history", "note") if kind == "note" else ("entity_history", "entity")
        current = note.revision if kind == "note" else self.entity(note_id)["revision"]
        with self.connection() as database:
            if revision is None:
                rows = database.execute(
                    f"SELECT revision FROM {table} WHERE note_id = ? ORDER BY revision DESC", (note_id,),
                )
                revisions = [row[0] for row in rows]
                if kind == "entity" and current:
                    revisions.append(0)
                return {"current": current, "revisions": revisions}
            if kind == "entity" and revision == 0 and current:
                return {"revision": 0, "fields": {}}
            row = database.execute(
                f"SELECT sealed FROM {table} WHERE note_id = ? AND revision = ?", (note_id, revision),
            ).fetchone()
        if not row:
            raise VaultError("Version not found.", 404)
        details = json.loads(unseal(cipher, row[0], self._context(purpose, note_id, revision)))
        return {"revision": revision, **details} if kind == "note" else {"revision": revision, "fields": details}

    def restore_history(self, note_id: str, kind: str, revision: int, expected: Any, *,
                        commit: Callable[[sqlite3.Connection, Note], None] | None = None) -> dict[str, Any]:
        cipher = self.require_unlocked()
        details = self.history(note_id, kind, revision)
        if kind == "entity":
            fields = details["fields"]
            if "relationships" in fields:
                fields["relationships"] = [
                    relation for relation in fields["relationships"] if relation["target"] in self.notes
                ]
            return self.update_entity(note_id, expected, fields, replace_fields=True)
        old = self._entity_note(note_id)
        if type(expected) is not int or old.revision != expected:
            raise VaultError("The note changed in another window. Reopen it.", 409)
        restored_title, trashed = details["title"], details["trashed"]
        aliases = list(dict.fromkeys([*details["aliases"], *old.aliases, old.title]))
        if not trashed and not old.path:
            if old.trashed:
                restored_title, aliases = self._names_for_restore(restored_title, aliases)
            else:
                if title_key(old.title) != title_key(restored_title):
                    self._check_title(restored_title, note_id)
                occupied = self._active_note_names(note_id)
                aliases = [alias for alias in aliases if title_key(alias) not in occupied]
        updated = replace(old, revision=old.revision + 1, title=restored_title,
                          body=details["body"], tags=details["tags"],
                          aliases=[alias for alias in aliases if title_key(alias) != title_key(restored_title)],
                          trashed=trashed, updated=datetime.now().isoformat(timespec="milliseconds"))
        with self.connection() as database, database:
            self._store(database, cipher, updated)
            if commit:
                commit(database, updated)
        self.notes[note_id] = updated
        self.changes += 1
        return self.get_note(note_id)

    def reminders(self) -> dict[str, str]:
        cipher = self.require_unlocked(touch=False)
        result = {}
        with self.connection() as database:
            for key, data in database.execute("SELECT name, value FROM metadata WHERE name GLOB 'reminder:*'"):
                note_id = key.removeprefix("reminder:")
                note = self.notes.get(note_id)
                if note and not note.trashed and not note.storage_only:
                    result[note_id] = unseal(cipher, data, self._context(key)).decode("ascii")
        return result

    def set_reminder(self, note_id: Any, when: Any, expected: Any) -> dict[str, str]:
        cipher = self.require_unlocked()
        if not isinstance(note_id, str) or not NOTE_ID.fullmatch(note_id):
            raise VaultError("Select a note.")
        note = self._entity_note(note_id)
        if note.trashed:
            raise VaultError("Restore the note before editing its reminder.", 409)
        if not isinstance(when, str) or (when and not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", when)):
            raise VaultError("Enter a valid reminder date.")
        if when:
            try:
                datetime.strptime(when, "%Y-%m-%dT%H:%M:%SZ")
            except ValueError as error:
                raise VaultError("Enter a valid reminder date.") from error
        key = "reminder:" + note_id
        with self.connection() as database, database:
            row = database.execute("SELECT value FROM metadata WHERE name = ?", (key,)).fetchone()
            current = unseal(cipher, row[0], self._context(key)).decode("ascii") if row else ""
            if expected != current:
                raise VaultError("The reminder was changed elsewhere.", 409)
            if when == current:
                return {"at": when}
            if when:
                encrypted = seal(cipher, when.encode("ascii"), self._context(key))
                database.execute("INSERT OR REPLACE INTO metadata VALUES (?, ?)", (key, encrypted))
            else:
                database.execute("DELETE FROM metadata WHERE name = ?", (key,))
        self.changes += 1
        return {"at": when}

    def tasks(self) -> list[dict[str, Any]]:
        self.require_unlocked()
        result = []
        locked_ids = self.locked_note_ids()
        for note in self.notes.values():
            if note.trashed or note.storage_only or note.id in locked_ids:
                continue
            fence = ""
            offset = 0
            phase, phase_offset = "", -1
            for line in note.body.splitlines(keepends=True):
                opening = FENCE.match(line)
                if opening:
                    token = opening[1]
                    if not fence:
                        fence = token
                    elif token.startswith(fence) and not line[opening.end():].strip():
                        fence = ""
                elif not fence and (heading := re.match(r"^ {0,3}##[ \t]+(.+?)\s*$", line)):
                    phase, phase_offset = heading[1], offset
                elif not fence and (match := TASK_LINE.match(line)):
                    result.append({"noteId": note.id, "noteTitle": note.title, "revision": note.revision,
                                   "offset": offset + match.start(2), "done": match[2] != " ",
                                   "text": match[4].strip(), "phase": phase, "phaseOffset": phase_offset})
                offset += len(line)
        return result

    def toggle_task(self, item: dict[str, Any]) -> dict[str, Any]:
        self.require_unlocked()
        note_id = item.get("noteId")
        if not isinstance(note_id, str):
            raise VaultError("Could not find the task note.", 404)
        note = self._entity_note(note_id)
        self.require_note_unlocked(note_id)
        offset, expected, done = item.get("offset"), item.get("revision"), item.get("done")
        if (type(expected) is not int or expected != note.revision or type(offset) is not int
                or type(done) is not bool or offset < 0 or offset >= len(note.body)):
            raise VaultError("The task changed. Refresh the list.", 409)
        start = max(note.body.rfind("\r", 0, offset), note.body.rfind("\n", 0, offset)) + 1
        match = TASK_LINE.match(note.body[start:])
        if not match or offset != start + match.start(2):
            raise VaultError("The task changed. Refresh the list.", 409)
        body = note.body[:offset] + ("x" if done else " ") + note.body[offset + 1:]
        return self.update_note(note_id, {"revision": expected, "title": note.title,
                                          "tags": note.tags, "body": body})

    def pinned_notes(self) -> set[str]:
        cipher = self.require_unlocked()
        with self.connection() as database:
            row = database.execute("SELECT value FROM metadata WHERE name = 'pinned_notes'").fetchone()
        return set(json.loads(unseal(cipher, row[0], self._context("pinned_notes")))) if row else set()

    def set_pinned(self, note_id: str, pinned: bool) -> list[str]:
        cipher = self.require_unlocked()
        note = self.notes.get(note_id)
        if note is None or note.trashed or note.storage_only:
            raise VaultError("Note not found.", 404)
        current = self.pinned_notes()
        if pinned:
            current.add(note_id)
        else:
            current.discard(note_id)
        ordered = sorted(current)
        data = seal(cipher, json.dumps(ordered, separators=(",", ":")).encode(), self._context("pinned_notes"))
        with self.connection() as database, database:
            database.execute("INSERT OR REPLACE INTO metadata VALUES ('pinned_notes', ?)", (data,))
        self.changes += 1
        return ordered

    def append_to_note(self, note_id: str, text: str) -> dict[str, Any]:
        cipher = self.require_unlocked()
        self.require_note_unlocked(note_id)
        old = self.notes.get(note_id)
        if old is None or old.trashed or old.storage_only:
            raise VaultError("Note not found.", 404)
        if not isinstance(text, str) or not text.strip():
            raise VaultError("Enter some text to append.")
        sep = "\n\n" if old.body and not old.body.endswith("\n") else ("\n" if old.body and not old.body.endswith("\n\n") else "")
        body = note_body(old.body + sep + text.strip())
        note = Note(
            note_id, old.revision + 1, old.title, body, old.tags, old.aliases,
            datetime.now().isoformat(timespec="milliseconds"), False, old.path, old.source,
        )
        with self.connection() as database, database:
            self._store(database, cipher, note)
        self.notes[note.id] = note
        self.changes += 1
        return self.get_note(note_id)

    @staticmethod
    def _unpublish(database: sqlite3.Connection, note_id: str) -> None:
        """A note that is trashed or deleted must never stay reachable through a public link."""
        try:
            database.execute("DELETE FROM public_shares WHERE note_id = ?", (note_id,))
        except sqlite3.OperationalError:
            pass  # this vault never published anything

    def graph_positions(self) -> dict[str, list[float]]:
        cipher = self.require_unlocked()
        with self.connection() as database:
            row = database.execute("SELECT value FROM metadata WHERE name = 'graph_positions'").fetchone()
        return json.loads(unseal(cipher, row[0], self._context("graph_positions"))) if row else {}

    def move_graph_node(self, item_id: Any, position: Any) -> None:
        cipher = self.require_unlocked()
        if not isinstance(item_id, str) or not re.fullmatch(r"[a-f0-9]{32}", item_id):
            raise VaultError("Invalid graph node.")
        if (not isinstance(position, list) or len(position) != 3 or
                not all(type(value) in (float, int) and -100 <= value <= 100 for value in position)):
            raise VaultError("Invalid graph position.")
        with self.connection() as database, database:
            note = self.notes.get(item_id)
            if note is None or note.trashed or note.storage_only:
                row = database.execute("SELECT note_id, name FROM attachments WHERE id = ?", (item_id,)).fetchone()
                if not row or self.notes[row[0]].trashed:
                    raise VaultError("Graph node not found.", 404)
                details = file_metadata(unseal(cipher, row[1], self._context("filename", row[0] + item_id)))
                if details.get("trashed"):
                    raise VaultError("Graph node not found.", 404)
            positions = self.graph_positions()
            positions[item_id] = position
            self._write_graph_positions(database, cipher, positions)
        self.changes += 1

    def _write_graph_positions(self, database: sqlite3.Connection, cipher: AESGCM,
                               positions: dict[str, list[float]]) -> None:
        data = seal(cipher, json.dumps(positions, separators=(",", ":")).encode(), self._context("graph_positions"))
        database.execute("INSERT OR REPLACE INTO metadata VALUES ('graph_positions', ?)", (data,))

    def _note_lock_record(self, note_id: str) -> dict[str, str] | None:
        cipher = self.require_unlocked(touch=False)
        key = "note_lock:" + note_id
        with self.connection() as database:
            row = database.execute("SELECT value FROM metadata WHERE name = ?", (key,)).fetchone()
        if not row:
            return None
        return json.loads(unseal(cipher, row[0], self._context(key)))

    def protected_note_ids(self) -> set[str]:
        self.require_unlocked(touch=False)
        with self.connection() as database:
            return {name.removeprefix("note_lock:") for name, in database.execute(
                "SELECT name FROM metadata WHERE name GLOB 'note_lock:*'")}

    def locked_note_ids(self) -> set[str]:
        return self.protected_note_ids() - self.unlocked_notes

    def require_note_unlocked(self, note_id: str) -> None:
        if self.is_note_locked(note_id):
            raise VaultError("Unlock this note before accessing its contents.", 403)

    def is_note_locked(self, note_id: str) -> bool:
        return note_id not in self.unlocked_notes and self._note_lock_record(note_id) is not None

    def set_note_password(self, note_id: str, password: Any, current_password: Any = "") -> dict[str, Any]:
        cipher = self.require_unlocked()
        self._entity_note(note_id)
        existing = self._note_lock_record(note_id)
        if existing is not None:
            if time.monotonic() < self.next_unlock:
                raise VaultError("Wait a few seconds before trying again.", 429)
            if not isinstance(current_password, str) or not 1 <= len(current_password) <= 128:
                raise VaultError("Enter the current note password first.", 403)
            salt = base64.b64decode(existing["salt"])
            expected = base64.b64decode(existing["hash"])
            if not hmac.compare_digest(vault_key(current_password, salt), expected):
                self.next_unlock = time.monotonic() + 2
                raise VaultError("The current note password is incorrect.", 403)
        key = "note_lock:" + note_id
        if password == "" or password is None:
            with self.connection() as database, database:
                database.execute("DELETE FROM metadata WHERE name = ?", (key,))
            self.unlocked_notes.discard(note_id)
            self.search_cache = None
            self.changes += 1
            return {"hasPassword": False, "locked": False}
        if not isinstance(password, str) or len(password) < 4 or len(password) > 128:
            raise VaultError("Use 4–128 characters for the note password.")
        salt = os.urandom(16)
        digest = vault_key(password, salt)
        record = {"salt": base64.b64encode(salt).decode("ascii"), "hash": base64.b64encode(digest).decode("ascii")}
        sealed = seal(cipher, json.dumps(record).encode("utf-8"), self._context(key))
        with self.connection() as database, database:
            database.execute("INSERT OR REPLACE INTO metadata VALUES (?, ?)", (key, sealed))
            self._unpublish(database, note_id)
        self._announce_unpublished([note_id])
        self.unlocked_notes.add(note_id)
        self.search_cache = None
        self.changes += 1
        return {"hasPassword": True, "locked": False}

    def unlock_note(self, note_id: str, password: Any) -> dict[str, Any]:
        self.require_unlocked()
        self._entity_note(note_id)
        if time.monotonic() < self.next_unlock:
            raise VaultError("Wait a few seconds before trying again.", 429)
        existing = self._note_lock_record(note_id)
        if existing is None:
            return self.get_note(note_id)
        if not isinstance(password, str) or not 1 <= len(password) <= 128:
            raise VaultError("Enter the note password.", 403)
        salt = base64.b64decode(existing["salt"])
        expected = base64.b64decode(existing["hash"])
        if not hmac.compare_digest(vault_key(password, salt), expected):
            self.next_unlock = time.monotonic() + 2
            raise VaultError("Incorrect note password.", 403)
        self.unlocked_notes.add(note_id)
        self.search_cache = None
        return self.get_note(note_id)

    def lock_note(self, note_id: str) -> None:
        self.require_unlocked(touch=False)
        self.unlocked_notes.discard(note_id)
        self.search_cache = None

    def get_note(self, note_id: str, *, resolve: bool = True) -> dict[str, Any]:
        cipher = self.require_unlocked()
        note = self.notes.get(note_id)
        if note is None or note.storage_only:
            raise VaultError("Note not found.", 404)
        has_pw = self._note_lock_record(note_id) is not None
        if has_pw and note_id not in self.unlocked_notes:
            return {
                "id": note.id, "revision": note.revision, "title": note.title,
                "body": "", "tags": note.tags, "aliases": note.aliases,
                "updated": note.updated, "trashed": note.trashed,
                "path": note.path, "source": note.source,
                "attachments": [], "links": {},
                "entity": {"revision": 0, "fields": {}},
                "locked": True, "hasPassword": True,
            }
        attachments = []
        with self.connection() as database:
            rows = database.execute(
                "SELECT id, name FROM attachments WHERE note_id = ? ORDER BY rowid", (note_id,)
            )
            for attachment_id, name in rows:
                raw = unseal(cipher, name, self._context("filename", note_id + attachment_id))
                details = file_metadata(raw)
                if not details.get("trashed"):
                    attachments.append({"id": attachment_id, **details})
        links = {}
        if resolve and not note.trashed:
            files = self.list_attachments()
            active = [item for item in self.notes.values() if not item.trashed and not item.storage_only]
            index = LinkIndex(active, files, title_key)
            for name, target in index.links_for(note).items():
                links[name] = target
            present = {file["id"] for file in attachments}
            referenced = set(links.values()) - present
            attachments.extend(file for file in files if file["id"] in referenced)
        return {**asdict(note), "attachments": attachments, "links": links,
                "entity": self.entity(note_id), "locked": False, "hasPassword": has_pw}

    def _store(self, database: sqlite3.Connection, cipher: AESGCM, note: Note) -> None:
        details = asdict(note)
        del details["id"], details["revision"]
        for optional in ("path", "source", "storage_only"):
            if not details[optional]:
                del details[optional]
        encrypted = seal(
            cipher, json.dumps(details, ensure_ascii=False).encode("utf-8"),
            self._context("note", note.id, note.revision),
        )
        if note.revision == 1:
            database.execute("INSERT INTO notes VALUES (?, ?, ?)", (note.id, note.revision, encrypted))
            return
        database.execute(
            """INSERT INTO note_history SELECT id, revision, sealed FROM notes
               WHERE id = ? AND revision = ?""", (note.id, note.revision - 1),
        )
        cursor = database.execute(
            "UPDATE notes SET revision = ?, sealed = ? WHERE id = ? AND revision = ?",
            (note.revision, encrypted, note.id, note.revision - 1),
        )
        if cursor.rowcount != 1:
            raise VaultError("A newer version of this note exists. Copy your text and reopen the note.", 409)

    def _active_note_names(self, exclude_id: str = "") -> set[str]:
        return {title_key(name) for note in self.notes.values()
                if not note.trashed and not note.storage_only and note.id != exclude_id
                for name in (note.title, *note.aliases)}

    def _check_title(self, title: str, note_id: str = "") -> None:
        if title_key(title) in self._active_note_names(note_id):
            raise VaultError(f"Another note already uses “{title}” as a title or previous title.", 409)

    def _names_for_restore(self, title: str, aliases: list[str]) -> tuple[str, list[str]]:
        occupied = self._active_note_names()
        title = self._unused_title(title, occupied)
        occupied.add(title_key(title))
        return title, [alias for alias in aliases if title_key(alias) not in occupied]

    def create_notes(self, items: Any, *,
                     commit: Callable[[sqlite3.Connection, list[Note]], None] | None = None) -> list[str]:
        cipher = self.require_unlocked()
        if not isinstance(items, list) or not 1 <= len(items) <= 200:
            raise VaultError("Create 1–200 notes at once.")
        prepared: list[Note] = []
        keys: set[str] = set()
        events: dict[str, str] = {}
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("title"), str):
                raise VaultError("Enter a note title.")
            if item.get("useAvailableTitle") is True:
                title = self._available_note_title(item["title"], keys)
            else:
                title = clean_title(item["title"])
                self._check_title(title)
            key = title_key(title)
            if key in keys:
                raise VaultError(f"Duplicate title “{title}”.", 409)
            keys.add(key)
            note = Note(
                uuid4().hex, 1, title, note_body(item.get("body", "")),
                note_tags(item.get("tags", [])), [], datetime.now().isoformat(timespec="milliseconds"),
            )
            if "eventDate" in item:
                try:
                    due = clean_field("due", item["eventDate"])
                except ValueError as error:
                    raise VaultError("Choose a valid event date.") from error
                if not isinstance(due, str) or not due:
                    raise VaultError("Choose a valid event date.")
                events[note.id] = due
            prepared.append(note)
        created_entities: dict[str, dict[str, Any]] = {}
        with self.connection() as database, database:
            for note in prepared:
                self._store(database, cipher, note)
                if note.id in events:
                    created_entities[note.id] = self._store_entity(database, cipher, note.id, 1,
                        {"type": "event", "due": events[note.id]})
            if commit:
                commit(database, prepared)
        self.notes.update((note.id, note) for note in prepared)
        self.entities.update(created_entities)
        self.changes += 1
        return [note.id for note in prepared]

    def update_note(self, note_id: str, item: dict[str, Any], *,
                    commit: Callable[[sqlite3.Connection, Note], None] | None = None) -> dict[str, Any]:
        cipher = self.require_unlocked()
        old = self.notes.get(note_id)
        if old is None or old.storage_only:
            raise VaultError("Note not found.", 404)
        if self.is_note_locked(note_id):
            raise VaultError("This note is locked. Enter its password first.", 423)
        if item.get("revision") != old.revision:
            raise VaultError("The note changed in another window. Copy your text and reopen the note.", 409)
        if "trashed" in item:
            if not isinstance(item["trashed"], bool):
                raise VaultError("Invalid note status.")
            title, body, tags, aliases, trashed = old.title, old.body, old.tags, old.aliases, item["trashed"]
            if old.trashed and not trashed and not old.path:
                title, aliases = self._names_for_restore(title, aliases)
        else:
            if old.trashed or not isinstance(item.get("title"), str):
                raise VaultError("Restore the note or provide a title to edit it.")
            title = old.title if item["title"] == old.title else clean_title(item["title"])
            if not old.path and title_key(title) != title_key(old.title):
                self._check_title(title, note_id)
            body, tags, trashed = note_body(item.get("body")), note_tags(item.get("tags")), False
            aliases = [name for name in old.aliases if title_key(name) != title_key(title)]
            if title_key(title) != title_key(old.title):
                aliases.append(old.title)
        if (title, body, tags, aliases, trashed) == (old.title, old.body, old.tags, old.aliases, old.trashed):
            return self.get_note(note_id)
        note = Note(
            note_id, old.revision + 1, title, body, tags, aliases,
            datetime.now().isoformat(timespec="milliseconds"), trashed, old.path, old.source,
        )
        with self.connection() as database, database:
            self._store(database, cipher, note)
            if trashed and not old.trashed:
                self._unpublish(database, note_id)
            if commit:
                commit(database, note)
        self.notes[note.id] = note
        self.changes += 1
        if trashed and not old.trashed:
            self._announce_unpublished([note_id])
        return self.get_note(note_id)

    def _announce_unpublished(self, note_ids: list[str]) -> None:
        if self.unpublished_hook:
            try:
                self.unpublished_hook(note_ids)
            except Exception:  # the hook reports its own failures; trashing must never fail because of it
                pass

    def list_attachments(self, trashed: bool = False) -> list[dict[str, Any]]:
        cipher = self.require_unlocked()
        files = []
        locked_ids = self.locked_note_ids()
        with self.connection() as database:
            rows = database.execute("SELECT id, note_id, name FROM attachments ORDER BY rowid DESC")
            for attachment_id, note_id, encrypted_name in rows:
                note = self.notes.get(note_id)
                if note is None or note.trashed or note_id in locked_ids:
                    continue
                data = unseal(cipher, encrypted_name, self._context("filename", note_id + attachment_id))
                details = file_metadata(data)
                if bool(details.get("trashed")) != trashed:
                    continue
                files.append({"id": attachment_id, **details, "noteId": note_id,
                              "noteTitle": details.get("path", note.title), "managed": note.storage_only})
        return files

    def trash_attachment(self, note_id: Any, file_id: Any, action: str) -> None:
        cipher = self.require_unlocked()
        if any(not isinstance(value, str) or not NOTE_ID.fullmatch(value) for value in (note_id, file_id)):
            raise VaultError("Invalid file selected.")
        with self.connection() as database, database:
            row = database.execute("SELECT name FROM attachments WHERE note_id = ? AND id = ?",
                                   (note_id, file_id)).fetchone()
            if row is None or self.notes[note_id].trashed:
                raise VaultError("File not found.", 404)
            context = self._context("filename", note_id + file_id)
            details = file_metadata(unseal(cipher, row[0], context))
            if action == "delete":
                if not details.get("trashed"):
                    raise VaultError("Move the file to Trash first.", 409)
                positions = self.graph_positions()
                positions.pop(file_id, None)
                self._delete_attachments(database, [file_id])
                self._write_graph_positions(database, cipher, positions)
            else:
                details.pop("trashed", None)
                if action == "move":
                    details["trashed"] = True
                metadata = b"\x00" + json.dumps(details, ensure_ascii=False).encode()
                database.execute("UPDATE attachments SET name = ? WHERE id = ?",
                                 (seal(cipher, metadata, context), file_id))
        self.changes += 1

    @staticmethod
    def _delete_attachments(database: sqlite3.Connection, file_ids: list[str]) -> None:
        database.executemany("DELETE FROM attachments WHERE id = ?", ((file_id,) for file_id in file_ids))

    def delete_trashed(self, expected: Any = None) -> list[str]:
        cipher = self.require_unlocked()
        if expected is not None:
            if not isinstance(expected, dict) or not isinstance(expected.get("id"), str):
                raise VaultError("Invalid note selected for deletion.")
            note = self.notes.get(expected["id"])
            if note is None or note.storage_only:
                raise VaultError("Note not found.", 404)
            if not note.trashed or expected.get("revision") != note.revision:
                raise VaultError("The note status changed. Reopen the trash.", 409)
            ids = [note.id]
        else:
            ids = [note.id for note in self.notes.values() if note.trashed and not note.storage_only]
        files = [file["id"] for file in self.list_attachments(trashed=True)] if expected is None else []
        if not ids and not files:
            return []
        positions = self.graph_positions()
        with self.connection() as database, database:
            self._delete_attachments(database, files)
            for file_id in files:
                positions.pop(file_id, None)
            for note_id in ids:
                positions.pop(note_id, None)
                for (file_id,) in database.execute("SELECT id FROM attachments WHERE note_id = ?", (note_id,)):
                    positions.pop(file_id, None)
                database.execute("DELETE FROM attachments WHERE note_id = ?", (note_id,))
                self._unpublish(database, note_id)
                self.unlocked_notes.discard(note_id)
                database.execute("DELETE FROM metadata WHERE name = ?", ("reminder:" + note_id,))
                database.execute("DELETE FROM metadata WHERE name = ?", ("note_lock:" + note_id,))
                database.execute("DELETE FROM notes WHERE id = ?", (note_id,))
            self._write_graph_positions(database, cipher, positions)
        for note_id in ids:
            del self.notes[note_id]
            self.topic_cache.pop(note_id, None)
            self.entities.pop(note_id, None)
        self.changes += 1
        self._announce_unpublished(ids)
        return ids

    def add_attachment(self, note_id: str, item: dict[str, Any]) -> dict[str, str]:
        data = item.get("data")
        if not isinstance(data, str):
            raise VaultError("Invalid file contents.")
        try:
            content = base64.b64decode(data, validate=True)
        except (ValueError, binascii.Error) as error:
            raise VaultError("Could not read the file.") from error
        return self.store_attachment(note_id, item.get("name"), content)

    def store_attachment(self, note_id: str, name: Any, content: bytes) -> dict[str, str]:
        cipher = self.require_unlocked()
        note = self.notes.get(note_id)
        if note is None or note.trashed:
            raise VaultError("The note is missing or in the trash.", 404)
        if not isinstance(name, str):
            raise VaultError("Invalid file name.")
        name = name.replace(chr(92), "/").split("/")[-1].strip()
        if not name or len(name) > 240 or any(ord(char) < 32 for char in name):
            raise VaultError("Invalid file name.")
        if len(content) > MAX_ATTACHMENT:
            raise VaultError("An attachment can be up to 64 MiB.", 413)
        metadata = name.encode("utf-8")
        words = attachment_terms(name, content)
        if words:
            metadata = b"\x00" + json.dumps({"name": name, "topicTerms": words}, ensure_ascii=False).encode()
        with self.connection() as database, database:
            attachment_id = self._store_file(database, cipher, note_id, metadata, content)
        self.changes += 1
        return {"id": attachment_id, "name": name}

    def _available_note_title(self, label: str, reserved: set[str] | None = None) -> str:
        base = clean_title(label.translate(str.maketrans({"[": "（", "]": "）", "#": "＃", "|": "｜"})))
        return self._unused_title(base, self._active_note_names() | (reserved or set()))

    @staticmethod
    def _unused_title(base: str, occupied: set[str]) -> str:
        title = base
        number = 2
        while title_key(title) in occupied:
            tail = f" ({number})"
            title = base[:120 - len(tail)].rstrip() + tail
            number += 1
        return title

    def _new_map_note(self, label: str, body: str = "") -> Note:
        title = self._available_note_title(label[:120])
        return Note(uuid4().hex, 1, title, note_body(body), [], [], datetime.now().isoformat(timespec="milliseconds"))

    def create_mind_map(self, item: dict[str, Any]) -> dict[str, Any]:
        cipher = self.require_unlocked()
        raw = item.get("map")
        if raw is None:
            if not isinstance(item.get("title"), str):
                raise VaultError("Enter a mind map name.")
            raw = new_map(item["title"])
        try:
            content, label, refs = encode_map(raw)
        except ValueError as error:
            raise VaultError(str(error)) from error
        owner_id = item.get("noteId")
        owner = None
        if owner_id is not None:
            if not isinstance(owner_id, str) or not NOTE_ID.fullmatch(owner_id):
                raise VaultError("Note not found.", 404)
            owner = self._entity_note(owner_id)
            if owner.trashed:
                raise VaultError("The note is in the trash.", 409)
        created = owner is None
        if created:
            owner = self._new_map_note(label)
        name = label[:120].rstrip().replace("/", "∕").replace(chr(92), "∖") + ".mindmap"
        details = {"name": name, "mapTitle": label, "mapRefs": refs}
        metadata = b"\x00" + json.dumps(details, ensure_ascii=False).encode()
        with self.connection() as database, database:
            if created:
                self._store(database, cipher, owner)
            attachment_id = self._store_file(database, cipher, owner.id, metadata, content)
        if created:
            self.notes[owner.id] = owner
        self.changes += 1
        return {"id": attachment_id, "noteId": owner.id, "name": name, "mapTitle": label}

    def update_mind_map(self, note_id: str, file_id: str, item: dict[str, Any]) -> dict[str, Any]:
        cipher = self.require_unlocked()
        identifier = note_id + file_id
        with self.connection() as database, database:
            row = database.execute(
                "SELECT name, contents FROM attachments WHERE note_id = ? AND id = ?",
                (note_id, file_id),
            ).fetchone()
            if row is None:
                raise VaultError("Mind map not found.", 404)
            details = file_metadata(unseal(cipher, row[0], self._context("filename", identifier)))
            if self.notes[note_id].trashed or details.get("trashed") or not details["name"].lower().endswith(".mindmap"):
                raise VaultError("This file cannot be edited as a mind map.", 415)
            old = unseal(cipher, row[1], self._context("attachment", identifier))
            if hashlib.sha256(old).hexdigest() != item.get("checksum"):
                raise VaultError("The mind map changed in another window. Download your current copy and reopen the map.", 409)
            branch = None
            raw = item.get("map")
            if "openTopic" in item:
                try:
                    raw = json.loads(encode_map(json.loads(old))[0])
                except ValueError as error:
                    raise VaultError("The stored mind map is invalid.") from error
                topic = next((topic for topic in raw["topics"] if topic["id"] == item["openTopic"]), None)
                if topic is None:
                    raise VaultError("Topic not found.", 404)
                if topic.get("ref"):
                    branch = self.notes.get(topic["ref"])
                    if branch is None or branch.trashed or branch.storage_only:
                        raise VaultError("The linked note is unavailable. Restore it or edit the link in Details.", 409)
                    return {"checksum": hashlib.sha256(old).hexdigest(), "mapTitle": details.get("mapTitle", details["name"].removesuffix(".mindmap")),
                            "noteId": branch.id}
                branch = self._new_map_note(topic["title"], topic.get("note", ""))
                topic["ref"] = branch.id
                self._store(database, cipher, branch)
            try:
                content, title, refs = encode_map(raw)
            except ValueError as error:
                raise VaultError(str(error)) from error
            details.update(mapTitle=title, mapRefs=refs)
            metadata = b"\x00" + json.dumps(details, ensure_ascii=False).encode()
            database.execute(
                "UPDATE attachments SET name = ?, contents = ? WHERE note_id = ? AND id = ?",
                (seal(cipher, metadata, self._context("filename", identifier)),
                 seal(cipher, content, self._context("attachment", identifier)), note_id, file_id),
            )
        self.changes += 1
        result = {"checksum": hashlib.sha256(content).hexdigest(), "mapTitle": title}
        if branch is not None:
            self.notes[branch.id] = branch
            result["noteId"] = branch.id
        return result

    def _store_file(self, database: sqlite3.Connection, cipher: AESGCM,
                    owner: str, metadata: bytes, content: bytes) -> str:
        attachment_id = uuid4().hex
        ident = owner + attachment_id
        database.execute(
            "INSERT INTO attachments VALUES (?, ?, ?, ?)",
            (attachment_id, owner, seal(cipher, metadata, self._context("filename", ident)),
             seal(cipher, content, self._context("attachment", ident))),
        )
        return attachment_id

    def import_folder(self, source: str, entries: Iterator[tuple[str, bytes]]) -> dict[str, int]:
        cipher = self.require_unlocked()
        stamp = datetime.now().isoformat(timespec="milliseconds")
        matching = [note for note in self.notes.values() if note.source == source]
        note_paths = {note.path for note in matching if note.path}
        owner = next((note for note in matching if note.storage_only), None)
        assets = {file["path"] for file in self.list_attachments() if file.get("source") == source}
        created = []
        summary = {"notes": 0, "files": 0, "existing": 0}
        with self.connection() as database, database:
            for path, content in entries:
                suffix = Path(path).suffix.lower()
                if suffix in {".md", ".markdown"}:
                    if path in note_paths:
                        summary["existing"] += 1
                        continue
                    try:
                        body = content.decode("utf-8-sig")
                    except UnicodeDecodeError as error:
                        raise VaultError(f"Could not read the UTF-8 note at {path}.") from error
                    if len(body) > MAX_BODY:
                        raise VaultError(f"The note at {path} exceeds {MAX_BODY:,} characters.")
                    imported_tags, aliases, invalid = frontmatter_names(body)
                    if invalid:
                        summary["frontmatterWarnings"] = summary.get("frontmatterWarnings", 0) + 1
                    inline_tags = sorted(set(re.findall(r"(?<![\w/])#([\w/-]{1,36})(?![\w/-])", body)))
                    tags = note_tags(list(dict.fromkeys([*imported_tags, *inline_tags]))[:12])
                    note = Note(uuid4().hex, 1, Path(path).stem[:120], body, tags,
                                list(dict.fromkeys(aliases))[:32], stamp,
                                path=path, source=source)
                    self._store(database, cipher, note)
                    note_paths.add(path)
                    created.append(note)
                    summary["notes"] += 1
                else:
                    if path in assets:
                        summary["existing"] += 1
                        continue
                    if owner is None:
                        owner = Note(uuid4().hex, 1, source, "", [], [], stamp, source=source, storage_only=True)
                        self._store(database, cipher, owner)
                        created.append(owner)
                    details = {"name": Path(path).name, "source": source, "path": path}
                    words = attachment_terms(details["name"], content)
                    if words:
                        details["topicTerms"] = words
                    metadata = b"\x00" + json.dumps(details, ensure_ascii=False).encode("utf-8")
                    self._store_file(database, cipher, owner.id, metadata, content)
                    assets.add(path)
                    summary["files"] += 1
        self.notes.update((note.id, note) for note in created)
        if summary["notes"] or summary["files"]:
            self.changes += 1
        self.last_activity = time.monotonic()
        return summary

    def attachment(self, note_id: str, attachment_id: str) -> tuple[str, bytes]:
        details, content = self._attachment(note_id, attachment_id)
        return details["name"], content

    def _attachment(self, note_id: str, attachment_id: str) -> tuple[dict[str, Any], bytes]:
        cipher = self.require_unlocked()
        self.require_note_unlocked(note_id)
        with self.connection() as database:
            row = database.execute(
                "SELECT name, contents FROM attachments WHERE note_id = ? AND id = ?",
                (note_id, attachment_id),
            ).fetchone()
        if row is None:
            raise VaultError("File not found.", 404)
        ident = note_id + attachment_id
        details = file_metadata(unseal(cipher, row[0], self._context("filename", ident)))
        return details, unseal(cipher, row[1], self._context("attachment", ident))

    def attachment_markup(self, note_id: str, file_id: str, surface: int,
                          update: dict[str, Any] | None = None) -> dict[str, Any]:
        cipher = self.require_unlocked()
        self.require_note_unlocked(note_id)
        if not 1 <= surface <= 100_000:
            raise VaultError("Invalid attachment page.")
        with self.connection() as database, database:
            if update is not None:
                database.execute("BEGIN IMMEDIATE")
            file = database.execute("SELECT name FROM attachments WHERE id = ? AND note_id = ?",
                                    (file_id, note_id)).fetchone()
            if not file:
                raise VaultError("File not found.", 404)
            ident = note_id + file_id
            details = file_metadata(unseal(cipher, file[0], self._context("filename", ident)))
            if update is not None and (details.get("trashed") or self.notes[note_id].trashed):
                raise VaultError("Restore the file before annotating it.", 409)
            row = database.execute(
                "SELECT revision, sealed FROM attachment_markup WHERE attachment_id = ? AND surface = ?",
                (file_id, surface),
            ).fetchone()
            purpose = f"file-markup.{surface}"
            revision = row[0] if row else 0
            if update is None:
                marks = json.loads(unseal(cipher, row[1], self._context(purpose, ident, revision))) if row else []
                return {"revision": revision, "marks": marks}
            expected = update.get("revision")
            if type(expected) is not int or expected != revision:
                raise VaultError("Annotations changed in another window. Reopen the file.", 409)
            data = markup_content(update.get("marks"))
            revision += 1
            encrypted = seal(cipher, data, self._context(purpose, ident, revision))
            database.execute("INSERT INTO attachment_markup VALUES (?, ?, ?, ?) "
                             "ON CONFLICT(attachment_id, surface) DO UPDATE SET revision=excluded.revision, sealed=excluded.sealed",
                             (file_id, surface, revision, encrypted))
        self.changes += 1
        return {"revision": revision}

    def _drawing_attachment(self, note_id: str, attachment_id: str) -> tuple[str, bytes]:
        details, image = self._attachment(note_id, attachment_id)
        name = details["name"]
        note = self.notes[note_id]
        if (note.trashed or note.storage_only or details.get("trashed")
                or not DRAWING_NAME.fullmatch(name) or not image.startswith(PNG_SIGNATURE)):
            raise VaultError("This drawing file cannot be edited.", 415)
        return name, image

    def drawing(self, note_id: str, attachment_id: str) -> dict[str, Any]:
        cipher = self.require_unlocked()
        _, image = self._drawing_attachment(note_id, attachment_id)
        with self.connection() as database:
            row = database.execute("SELECT revision, strokes, base FROM drawings WHERE attachment_id = ?",
                                   (attachment_id,)).fetchone()
        ident = note_id + attachment_id
        if row is None:
            return {"revision": 0, "strokes": [], "base": base64.b64encode(image).decode("ascii")}
        revision, strokes, encrypted_base = row
        base = unseal(cipher, encrypted_base, self._context("drawing-base", ident)) if encrypted_base else b""
        return {"revision": revision, "base": base64.b64encode(base).decode("ascii"),
                "strokes": json.loads(unseal(cipher, strokes, self._context("drawing", ident, revision)))}

    def create_drawing(self, note_id: str, item: dict[str, Any]) -> dict[str, Any]:
        cipher = self.require_unlocked()
        note = self.notes.get(note_id)
        if note is None or note.trashed or note.storage_only:
            raise VaultError("The note is missing or in the trash.", 404)
        if item.get("revision") != note.revision:
            raise VaultError("The note changed before the drawing was saved. Reopen the note.", 409)
        offset = item.get("offset")
        if type(offset) is not int or not 0 <= offset <= len(note.body):
            raise VaultError("Invalid position for the drawing in the note.")
        image, strokes = drawing_content(item)
        stamp = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
        name = f"Chizma-{stamp}-{uuid4().hex[:8]}.png"
        with self.connection() as database, database:
            attachment_id = self._store_file(database, cipher, note_id, name.encode(), image)
            ident = note_id + attachment_id
            encrypted = seal(cipher, strokes, self._context("drawing", ident, 1))
            database.execute("INSERT INTO drawings VALUES (?, 1, ?, NULL)", (attachment_id, encrypted))
            body = note_body(note.body[:offset] + f"\n\n![Chizma](attachment:{attachment_id})\n\n" + note.body[offset:])
            updated = replace(note, revision=note.revision + 1, body=body,
                              updated=datetime.now().isoformat(timespec="milliseconds"))
            self._store(database, cipher, updated)
        self.notes[note_id] = updated
        self.changes += 1
        return {"note": self.get_note(note_id), "id": attachment_id}

    def update_drawing(self, note_id: str, attachment_id: str, item: dict[str, Any]) -> dict[str, int]:
        cipher = self.require_unlocked()
        _, old_image = self._drawing_attachment(note_id, attachment_id)
        image, strokes = drawing_content(item)
        ident = note_id + attachment_id
        with self.connection() as database, database:
            row = database.execute("SELECT revision, base FROM drawings WHERE attachment_id = ?",
                                   (attachment_id,)).fetchone()
            revision = row[0] if row else 0
            if type(item.get("revision")) is not int or item["revision"] != revision:
                raise VaultError("The drawing changed in another window. Reopen it.", 409)
            keep_base = item.get("keepBase") is True
            base = (row[1] if row else seal(cipher, old_image, self._context("drawing-base", ident))) if keep_base else None
            revision += 1
            encrypted = seal(cipher, strokes, self._context("drawing", ident, revision))
            database.execute("INSERT OR REPLACE INTO drawings VALUES (?, ?, ?, ?)",
                             (attachment_id, revision, encrypted, base))
            database.execute("UPDATE attachments SET contents = ? WHERE id = ? AND note_id = ?",
                             (seal(cipher, image, self._context("attachment", ident)), attachment_id, note_id))
        self.changes += 1
        return {"revision": revision}

    def delete_drawing(self, note_id: str, attachment_id: str, revision: Any) -> dict[str, Any]:
        cipher = self.require_unlocked()
        self._drawing_attachment(note_id, attachment_id)
        note = self.notes[note_id]
        if note.revision != revision:
            raise VaultError("The note changed. Reopen the drawing.", 409)
        marker = r"!\[(?:\\[^\r\n]|[^\]\r\n])*\]\(attachment:" + re.escape(attachment_id) + r"\)"
        reference_line = re.compile(r"^[ \t]*" + marker + r"[ \t]*(?:\r?\n)?$")
        body = map_unfenced_lines(note.body, lambda line: "" if reference_line.fullmatch(line) else line)
        updated = replace(note, revision=note.revision + 1, body=body,
                          updated=datetime.now().isoformat(timespec="milliseconds"))
        positions = self.graph_positions()
        with self.connection() as database, database:
            database.execute("DELETE FROM attachments WHERE id = ? AND note_id = ?", (attachment_id, note_id))
            self._store(database, cipher, updated)
            if positions.pop(attachment_id, None) is not None:
                self._write_graph_positions(database, cipher, positions)
        self.notes[note_id] = updated
        self.changes += 1
        return self.get_note(note_id)

    def update_canvas(self, note_id: str, attachment_id: str, item: dict[str, Any]) -> dict[str, str]:
        cipher = self.require_unlocked()
        details, old = self._attachment(note_id, attachment_id)
        if not details["name"].lower().endswith(".canvas") or details.get("trashed") or self.notes[note_id].trashed:
            raise VaultError("This canvas file cannot be edited.", 415)
        if hashlib.sha256(old).hexdigest() != item.get("checksum"):
            raise VaultError("The canvas changed in another window. Reopen the file.", 409)
        canvas = item.get("canvas")
        if not isinstance(canvas, dict) or any(not isinstance(canvas.get(key, []), list) for key in ("nodes", "edges")):
            raise VaultError("Invalid canvas file format.")
        try:
            content = (json.dumps(canvas, ensure_ascii=False, allow_nan=False, indent=2) + "\n").encode()
        except (ValueError, UnicodeError) as error:
            raise VaultError("The canvas contains an invalid value.") from error
        if len(content) > MAX_CANVAS:
            raise VaultError("A canvas can be up to 8 MiB.", 413)
        encrypted = seal(cipher, content, self._context("attachment", note_id + attachment_id))
        with self.connection() as database, database:
            database.execute("UPDATE attachments SET contents = ? WHERE id = ? AND note_id = ?",
                             (encrypted, attachment_id, note_id))
        self.changes += 1
        return {"checksum": hashlib.sha256(content).hexdigest()}

    def backup(self, destination: Path) -> None:
        descriptor, name = tempfile.mkstemp(prefix=".snapshot-", dir=destination.parent)
        os.close(descriptor)
        temporary = Path(name)
        try:
            with self.connection() as source:
                target = sqlite3.connect(temporary)
                try:
                    source.backup(target)
                    target.execute("PRAGMA secure_delete = ON")
                    with target:
                        removed = target.execute("DELETE FROM metadata WHERE name GLOB 'ai_*'").rowcount
                    if removed:
                        target.execute("VACUUM")
                    if target.execute("PRAGMA quick_check").fetchone() != ("ok",):
                        raise VaultError("The backup failed its integrity check.")
                finally:
                    target.close()
            with temporary.open("r+b") as file:
                file.flush()
                os.fsync(file.fileno())
            try:
                os.link(temporary, destination)
            except OSError as error:
                if error.errno not in (errno.EOPNOTSUPP, errno.ENOSYS, errno.EPERM):
                    raise
                with destination.open("xb"):
                    pass
                try:
                    os.replace(temporary, destination)
                except OSError:
                    destination.unlink()
                    raise
        finally:
            temporary.unlink(missing_ok=True)
