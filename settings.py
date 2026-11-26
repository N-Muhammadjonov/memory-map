"""Small encrypted key/value settings kept inside the vault (same sealing as every other vault record)."""

from __future__ import annotations

import json
from sqlite3 import Connection
from typing import Any

from vault import Vault, VaultError, seal, unseal


def load(vault: Vault, name: str, default: Any) -> Any:
    cipher = vault.require_unlocked()
    with vault.connection() as database:
        row = database.execute("SELECT value FROM metadata WHERE name = ?", (name,)).fetchone()
    return json.loads(unseal(cipher, row[0], vault._context(name))) if row else default


def save(vault: Vault, name: str, value: Any, *, transaction: Connection | None = None) -> None:
    cipher = vault.require_unlocked()
    data = seal(cipher, json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode(), vault._context(name))
    if transaction is not None:
        transaction.execute("INSERT OR REPLACE INTO metadata VALUES (?, ?)", (name, data))
        return
    with vault.connection() as database, database:
        database.execute("INSERT OR REPLACE INTO metadata VALUES (?, ?)", (name, data))
    vault.changes += 1


def save_database_view(vault: Vault, body: dict[str, Any]) -> list[dict[str, Any]]:
    existing = load(vault, "database_views", [])
    record = body.get("view")
    action = body.get("action")
    if action == "remove":
        identity = body.get("id")
        if not isinstance(identity, str):
            raise VaultError("Choose a saved database view.")
        result = [view for view in existing if view["id"] != identity]
    elif action == "save" and isinstance(record, dict):
        identity, name, term = (record.get(key) for key in ("id", "name", "filterText"))
        if (not isinstance(identity, str) or not identity.startswith("view_") or len(identity) > 45
                or not isinstance(name, str) or not 1 <= len(name.strip()) <= 40
                or not isinstance(term, str) or len(term) > 200):
            raise VaultError("The saved view has an invalid name or search term.")
        clean = {"id": identity, "name": name.strip(), "filterText": term}
        choices = {
            "mode": ("table", "kanban", "gantt", "tasks", "gallery", "calendar", "roadmaps"),
            "groupBy": ("", "status", "priority", "type", "folder", "tag"),
            "sortBy": ("updated", "title", "links", "words"),
            "filterPreset": ("", "overdue", "due-soon", "high", "doing", "favorites"),
            "taskFilter": ("open", "done", "all"),
        }
        for field, allowed in choices.items():
            value = record.get(field, allowed[0])
            if value not in allowed:
                raise VaultError("The saved view has an invalid filter or layout.")
            clean[field] = value
        clean["sortDir"] = 1 if record.get("sortDir") == 1 else -1
        result = [view for view in existing if view["id"] != identity] + [clean]
        if len(result) > 40:
            raise VaultError("Delete a saved view before adding another.", 409)
    else:
        raise VaultError("Choose whether to save or remove a database view.")
    save(vault, "database_views", result)
    return result
