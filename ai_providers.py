"""Local credential storage and migration from V32. This module does not use the network."""

from __future__ import annotations

import base64
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

from crypto_backend import InvalidTag
from crypto_backend import AESGCM

import settings
from vault import Vault, VaultError, seal, unseal

SETTING = "ai_provider_connections"
LABELS = {
    "openai": "OpenAI", "anthropic": "Claude (Anthropic)", "gemini": "Gemini (Google)",
    "xai": "Grok (xAI)", "groq": "Groq", "qwen": "Qwen (Alibaba Cloud)",
    "deepseek": "DeepSeek", "mistral": "Mistral", "cloud_api": "Cloud adapter", "local_model": "Local model",
}
QWEN_REGIONS = {
    "ap-southeast-1": "Singapore", "us-east-1": "Virginia", "cn-beijing": "Beijing",
    "cn-hongkong": "Hong Kong", "eu-central-1": "Frankfurt", "ap-northeast-1": "Tokyo",
}
CONTEXT = b"MemoryMap/AI-credentials/1/"


def credential_path(vault_path: Path) -> Path:
    return vault_path.with_name(vault_path.name + ".ai-credentials")


def records(path: Path) -> list[str]:
    if path.is_symlink():
        raise VaultError("The local AI credential file cannot be a symbolic link.", 409)
    if not path.exists():
        return []
    if not path.is_file():
        raise VaultError("The local AI credential file is not a regular file.", 409)
    with path.open("rb") as file:
        raw = file.read(256_001)
    try:
        result = json.loads(raw)
        if len(raw) > 256_000 or not isinstance(result, list) or not 1 <= len(result) <= 2 or not all(
            isinstance(value, str) for value in result
        ):
            raise ValueError()
        return result
    except (ValueError, TypeError) as exc:
        raise VaultError("Could not read local AI credentials. Check the local configuration.", 409) from exc


def decode(cipher: AESGCM, vault_id: bytes, values: list[str]) -> dict[str, Any]:
    for encoded in values:
        try:
            result = json.loads(unseal(cipher, base64.b64decode(encoded, validate=True), CONTEXT + vault_id))
            if isinstance(result, dict):
                return result
        except (InvalidTag, ValueError, TypeError):
            continue
    if values:
        raise VaultError("The local AI credentials belong to another vault or are damaged.", 409)
    return {}


def encode(cipher: AESGCM, vault_id: bytes, data: dict[str, Any]) -> str:
    value = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
    return base64.b64encode(seal(cipher, value, CONTEXT + vault_id)).decode("ascii")


def write(path: Path, values: list[str]) -> None:
    fd, name = tempfile.mkstemp(prefix=".local-ai-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="ascii") as file:
            json.dump(values, file, separators=(",", ":"))
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def read(vault: Vault) -> dict[str, Any]:
    cipher = vault.require_unlocked()
    path = credential_path(vault.path)
    return decode(cipher, vault.vault_id, records(path))


def migrate(vault: Vault) -> None:
    with vault.connection() as database:
        found = database.execute("SELECT 1 FROM metadata WHERE name = ?", (SETTING,)).fetchone()
    if not found:
        return
    legacy = settings.load(vault, SETTING, {})
    if not isinstance(legacy, dict):
        raise VaultError("The old AI credentials could not be migrated.", 409)
    path = credential_path(vault.path)
    saved = read(vault)
    backup = vault.path.with_name(vault.path.name + ".pre-ai-storage.xotira")
    if not backup.exists():
        vault.backup(backup)
    if legacy:
        write(path, [encode(vault.require_unlocked(), vault.vault_id, {**legacy, **saved})])
    with vault.connection() as database, database:
        database.execute("PRAGMA secure_delete = ON")
        database.execute("DELETE FROM metadata WHERE name = ?", (SETTING,))
    vault.changes += 1


def rekey(path: Path, vault_id: bytes, old: AESGCM, new: AESGCM) -> None:
    target = credential_path(path)
    existing = records(target)
    if existing:
        data = decode(old, vault_id, existing)
        write(target, [encode(old, vault_id, data), encode(new, vault_id, data)])


def compact(vault: Vault) -> None:
    target = credential_path(vault.path)
    existing = records(target)
    if len(existing) == 2:
        cipher = vault.require_unlocked()
        write(target, [encode(cipher, vault.vault_id, decode(cipher, vault.vault_id, existing))])


def connection_status(vault: Vault) -> dict[str, Any]:
    migrate(vault)
    saved = read(vault)
    return {"providers": [{"id": name, "label": label, "configured": name in saved,
                           "workspace": saved.get(name, {}).get("workspace", ""),
                           "region": saved.get(name, {}).get("region", "")}
                          for name, label in LABELS.items()],
            "qwenRegions": QWEN_REGIONS}


def save_connection(vault: Vault, body: dict[str, Any]) -> dict[str, Any]:
    name = body.get("provider")
    if not isinstance(name, str) or name not in LABELS:
        raise VaultError("Choose a credential-capable AI provider.")
    migrate(vault)
    data = read(vault)
    if body.get("action") == "remove":
        data.pop(name, None)
    elif body.get("action") == "save":
        key = body.get("apiKey")
        if not isinstance(key, str) or not re.fullmatch(r"[!-~]{1,1024}", key.strip()):
            raise VaultError("Enter a valid API key for the selected provider.")
        profile = {**data.get(name, {}), "key": key.strip()}
        if name == "qwen" and ("workspace" in body or "region" in body):
            workspace, region = body.get("workspace"), body.get("region")
            if not isinstance(workspace, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", workspace) or region not in QWEN_REGIONS:
                raise VaultError("Choose a valid Alibaba Model Studio workspace and region.")
            profile.update(workspace=workspace, region=region)
        data[name] = profile
    else:
        raise VaultError("Choose whether to save or remove the key.")
    path = credential_path(vault.path)
    if data:
        write(path, [encode(vault.require_unlocked(), vault.vault_id, data)])
    else:
        path.unlink(missing_ok=True)
    return connection_status(vault)
