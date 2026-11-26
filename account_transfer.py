"""Encrypted account-to-account ZIP export and import for Xotira."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import stat
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4
from zipfile import BadZipFile, ZIP_DEFLATED, ZIP_STORED, ZipFile

from crypto_backend import InvalidTag
from crypto_backend import AESGCM
from crypto_backend import Argon2id

from entity_fields import clean_field
from vault import (
    MAX_ATTACHMENT,
    Note,
    Vault,
    VaultError,
    clean_title,
    note_body,
    note_tags,
    title_key,
)

TRANSFER_SCHEMA = "xotira-transfer/1"
MANIFEST_ENTRY = "manifest.json"
PAYLOAD_ENTRY = "payload.enc"
MIN_PASSPHRASE = 8
MAX_PASSPHRASE = 512
MAX_TRANSFER_PAYLOAD = 512 * 1024 * 1024
KDF_ITERATIONS = 3
KDF_LANES = 4
KDF_MEMORY_COST = 65536


def _validate_passphrase(passphrase: Any) -> str:
    if not isinstance(passphrase, str) or not MIN_PASSPHRASE <= len(passphrase) <= MAX_PASSPHRASE:
        raise VaultError(f"Enter a transfer passphrase of {MIN_PASSPHRASE}–{MAX_PASSPHRASE} characters.")
    return passphrase


def _derive_transfer_cipher(passphrase: str, salt: bytes, kdf: dict[str, int] | None = None) -> AESGCM:
    iterations = int((kdf or {}).get("iterations", KDF_ITERATIONS))
    lanes = int((kdf or {}).get("lanes", KDF_LANES))
    memory_cost = int((kdf or {}).get("memoryCost", KDF_MEMORY_COST))
    if not (1 <= iterations <= 10 and 1 <= lanes <= 8 and 8192 <= memory_cost <= 262144):
        raise VaultError("Unsupported key derivation parameters in transfer archive.")
    key = Argon2id(
        salt=salt,
        length=32,
        iterations=iterations,
        lanes=lanes,
        memory_cost=memory_cost,
    ).derive(passphrase.encode("utf-8"))
    return AESGCM(key)


def _transfer_aad(salt: bytes) -> bytes:
    return b"Xotira/transfer/1/" + hashlib.sha256(salt).digest()


def build_encrypted_transfer_zip(
    vault: Vault,
    passphrase: Any,
    *,
    note_ids: list[str] | None = None,
) -> tuple[bytes, dict[str, int]]:
    """Bundle selected or all active notes into an AES-256-GCM encrypted ZIP."""
    vault.require_unlocked()
    secret = _validate_passphrase(passphrase)
    protected_ids = vault.protected_note_ids()

    if note_ids is not None:
        if not isinstance(note_ids, list) or not note_ids or not all(isinstance(item, str) for item in note_ids):
            raise VaultError("Select at least one valid note to export.")
        selected_ids = set(note_ids)
        if selected_ids & protected_ids:
            raise VaultError("Use an encrypted vault backup to transfer password-protected notes.", 409)
        notes = [
            note for note in vault.notes.values()
            if note.id in selected_ids and not note.trashed and not note.storage_only
        ]
        if not notes:
            raise VaultError("No matching active notes found to export.", 404)
    else:
        notes = [note for note in vault.notes.values()
                 if not note.trashed and not note.storage_only and note.id not in protected_ids]

    notes.sort(key=lambda item: item.updated)
    serialized_notes: list[dict[str, Any]] = []
    attachment_count = 0

    for note in notes:
        detail = vault.get_note(note.id, resolve=False)
        files_payload: list[dict[str, str]] = []
        for file_meta in detail["attachments"]:
            if file_meta.get("managed"):
                continue
            name, content = vault.attachment(note.id, file_meta["id"])
            files_payload.append({
                "id": file_meta["id"],
                "name": name,
                "data": base64.b64encode(content).decode("ascii"),
            })
            attachment_count += 1
        serialized_notes.append({
            "id": note.id,
            "title": note.title,
            "body": note.body,
            "tags": list(note.tags),
            "aliases": list(note.aliases),
            "updated": note.updated,
            "entity": vault.entity(note.id).get("fields", {}),
            "attachments": files_payload,
        })

    payload_obj = {
        "schema": TRANSFER_SCHEMA,
        "exportedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "notes": serialized_notes,
    }
    raw_payload = json.dumps(payload_obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    salt = os.urandom(16)
    nonce = os.urandom(12)
    cipher = _derive_transfer_cipher(secret, salt)
    encrypted_payload = nonce + cipher.encrypt(nonce, raw_payload, _transfer_aad(salt))
    payload_sha256 = hashlib.sha256(encrypted_payload).hexdigest()

    manifest = {
        "schema": TRANSFER_SCHEMA,
        "createdAt": payload_obj["exportedAt"],
        "notesCount": len(serialized_notes),
        "attachmentsCount": attachment_count,
        "cipher": "AES-256-GCM",
        "kdf": {
            "name": "argon2id",
            "salt": base64.b64encode(salt).decode("ascii"),
            "iterations": KDF_ITERATIONS,
            "lanes": KDF_LANES,
            "memoryCost": KDF_MEMORY_COST,
        },
        "payloadSha256": payload_sha256,
    }

    buffer = io.BytesIO()
    with ZipFile(buffer, "w", ZIP_DEFLATED) as archive:
        archive.writestr(MANIFEST_ENTRY, json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"))
        archive.writestr(PAYLOAD_ENTRY, encrypted_payload, compress_type=ZIP_STORED)

    return buffer.getvalue(), {"notes": len(serialized_notes), "attachments": attachment_count}


def import_encrypted_transfer_zip(
    vault: Vault,
    zip_bytes: bytes,
    passphrase: Any,
    *,
    conflict: str = "rename",
) -> dict[str, int]:
    """Decrypt and import an encrypted account transfer ZIP into the unlocked vault."""
    cipher = vault.require_unlocked()
    secret = _validate_passphrase(passphrase)
    if conflict not in {"rename", "skip"}:
        raise VaultError("Invalid conflict resolution mode. Use 'rename' or 'skip'.")

    try:
        with ZipFile(io.BytesIO(zip_bytes)) as archive:
            infos = archive.infolist()
            names = [item.filename for item in infos]
            if len(infos) > 10 or MANIFEST_ENTRY not in names or PAYLOAD_ENTRY not in names:
                raise VaultError("Invalid encrypted transfer archive structure.")
            for item in infos:
                if item.is_dir():
                    continue
                if item.filename.startswith("/") or ".." in item.filename.split("/") or "\\" in item.filename:
                    raise VaultError("Unsafe path inside transfer archive.")
                if stat.S_ISLNK(item.external_attr >> 16):
                    raise VaultError("Symbolic links are not allowed in transfer archives.")
                if item.file_size > MAX_TRANSFER_PAYLOAD:
                    raise VaultError("Transfer archive exceeds size limit.", 413)
            manifest_raw = archive.read(MANIFEST_ENTRY)
            encrypted_payload = archive.read(PAYLOAD_ENTRY)
    except (BadZipFile, KeyError, RuntimeError, EOFError) as error:
        raise VaultError("Could not read the encrypted transfer ZIP.") from error

    try:
        manifest = json.loads(manifest_raw.decode("utf-8"))
        if manifest.get("schema") != TRANSFER_SCHEMA:
            raise VaultError("Unsupported transfer archive schema.")
        expected_sha = manifest.get("payloadSha256", "")
        if not isinstance(expected_sha, str) or hashlib.sha256(encrypted_payload).hexdigest() != expected_sha:
            raise VaultError("Transfer archive integrity check failed.")
        kdf = manifest.get("kdf") or {}
        salt = base64.b64decode(kdf["salt"], validate=True)
        if len(salt) != 16 or len(encrypted_payload) < 28:
            raise VaultError("Corrupted transfer archive header.")
        transfer_cipher = _derive_transfer_cipher(secret, salt, kdf)
        decrypted = transfer_cipher.decrypt(encrypted_payload[:12], encrypted_payload[12:], _transfer_aad(salt))
        payload = json.loads(decrypted.decode("utf-8"))
    except InvalidTag as error:
        raise VaultError("Incorrect transfer passphrase or tampered archive.", 403) from error
    except (KeyError, ValueError, UnicodeError, TypeError) as error:
        raise VaultError("Could not parse the decrypted transfer payload.") from error

    raw_notes = payload.get("notes")
    if not isinstance(raw_notes, list) or len(raw_notes) > 20_000:
        raise VaultError("Invalid note list in transfer payload.")

    existing_titles = {
        title_key(name)
        for note in vault.notes.values()
        if not note.storage_only
        for name in (note.title, *note.aliases)
    }
    id_remap: dict[str, str] = {}
    prepared: list[tuple[Note, dict[str, Any], list[tuple[str, bytes]]]] = []
    reserved: set[str] = set()
    summary = {"notes": 0, "attachments": 0, "skipped": 0, "renamed": 0}
    stamp = datetime.now().isoformat(timespec="milliseconds")

    for entry in raw_notes:
        if not isinstance(entry, dict) or not isinstance(entry.get("title"), str):
            raise VaultError("Invalid note record in transfer archive.")
        raw_title = clean_title(entry["title"])
        key = title_key(raw_title)
        if key in existing_titles or key in reserved:
            if conflict == "skip":
                summary["skipped"] += 1
                continue
            final_title = vault._available_note_title(raw_title, reserved)
            summary["renamed"] += 1
        else:
            final_title = raw_title
        reserved.add(title_key(final_title))

        new_id = uuid4().hex
        old_id = entry.get("id")
        if isinstance(old_id, str):
            id_remap[old_id] = new_id

        body = note_body(entry.get("body", ""))
        tags = note_tags(entry.get("tags", []))
        raw_aliases = entry.get("aliases") if isinstance(entry.get("aliases"), list) else []
        aliases = [
            clean_title(alias) for alias in raw_aliases
            if isinstance(alias, str) and alias.strip()
            and title_key(alias) != title_key(final_title)
            and title_key(alias) not in existing_titles
            and title_key(alias) not in reserved
        ][:16]

        entity_fields: dict[str, Any] = {}
        raw_entity = entry.get("entity")
        if isinstance(raw_entity, dict):
            for field_name, field_val in raw_entity.items():
                if field_name == "relationships":
                    continue
                try:
                    entity_fields[field_name] = clean_field(field_name, field_val)
                except (ValueError, TypeError):
                    continue

        attachments: list[tuple[str, bytes]] = []
        raw_files = entry.get("attachments") if isinstance(entry.get("attachments"), list) else []
        for file_item in raw_files:
            if not isinstance(file_item, dict) or not isinstance(file_item.get("name"), str) or not isinstance(file_item.get("data"), str):
                continue
            file_name = file_item["name"].replace("\\", "/").split("/")[-1].strip()
            if not file_name or len(file_name) > 240:
                continue
            try:
                content = base64.b64decode(file_item["data"], validate=True)
            except (ValueError, TypeError) as error:
                raise VaultError(f"Corrupted attachment in transfer archive: {file_name}") from error
            if len(content) > MAX_ATTACHMENT:
                raise VaultError(f"Attachment '{file_name}' exceeds 64 MiB limit.", 413)
            attachments.append((file_name, content))

        note = Note(new_id, 1, final_title, body, tags, aliases, stamp)
        prepared.append((note, entity_fields, attachments))

    created_notes: dict[str, Note] = {}
    created_entities: dict[str, dict[str, Any]] = {}
    with vault.connection() as database, database:
        for note, fields, attachments in prepared:
            updated_body = note.body
            for old_id, mapped_id in id_remap.items():
                updated_body = updated_body.replace(f"(xotira:{old_id})", f"(xotira:{mapped_id})")
            final_note = Note(
                note.id, note.revision, note.title, updated_body, note.tags, note.aliases, note.updated
            )
            vault._store(database, cipher, final_note)
            created_notes[final_note.id] = final_note
            if fields:
                created_entities[final_note.id] = vault._store_entity(database, cipher, final_note.id, 1, fields)
            for file_name, content in attachments:
                vault._store_file(database, cipher, final_note.id, file_name.encode("utf-8"), content)
                summary["attachments"] += 1
            summary["notes"] += 1

    if created_notes:
        vault.notes.update(created_notes)
        vault.entities.update(created_entities)
        vault.changes += 1
    return summary
