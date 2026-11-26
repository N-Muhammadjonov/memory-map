"""Persist pending changes and apply them through ordinary vault commands."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import settings
from vault import Note, Vault, VaultError, title_key

from .context import allowed, hidden_notes

PROPOSALS = "ai_proposals"
AUDIT = "ai_audit_log"
LIFETIME = 24 * 60 * 60
ACTIVE_LIMIT = 48


def usage(vault: Vault) -> dict[str, Any]:
    month = datetime.now(timezone.utc).strftime("%Y-%m")
    stored = settings.load(vault, "ai_usage", {})
    if stored.get("month") != month:
        return {"month": month, "requests": 0, "approvals": 0, "tokens": 0}
    return {"approvals": 0, **stored}


def records(vault: Vault, now: float) -> list[dict[str, Any]]:
    proposals = settings.load(vault, PROPOSALS, [])
    expired = [item for item in proposals if item["status"] == "pending" and now - item["createdAt"] >= LIFETIME]
    for item in expired:
        item["status"] = "expired"
    if expired:
        settings.save(vault, PROPOSALS, proposals)
    return proposals


def add(vault: Vault, tool: str, source: str, diff: Any, now: float) -> dict[str, Any]:
    proposals = records(vault, now)
    if len(proposals) >= ACTIVE_LIMIT:
        removable = next((item for item in proposals if item["status"] != "pending"), None)
        if removable is None:
            raise VaultError("Review existing AI proposals before creating more.", 409)
        proposals.remove(removable)
    item = {"id": uuid4().hex, "createdAt": now, "tool": tool, "source": source,
            "status": "pending", **diff}
    proposals.append(item)
    settings.save(vault, PROPOSALS, proposals)
    return item


def audit(vault: Vault, provider: str, kind: str, *, tool: str = "",
          input_tokens: int = 0, output_tokens: int = 0) -> None:
    rows = settings.load(vault, AUDIT, [])
    row = {"time": datetime.now(timezone.utc).isoformat(timespec="seconds"), "provider": provider,
           "event": kind, "tool": tool, "inputTokens": input_tokens, "outputTokens": output_tokens}
    settings.save(vault, AUDIT, [*rows[-199:], row])


def visible_records(vault: Vault, now: float) -> list[dict[str, Any]]:
    hidden = hidden_notes(vault)
    items = records(vault, now)
    return [item for item in reversed(items)
            if item.get("noteId") not in hidden and (item.get("related") or {}).get("id") not in hidden]


def decide(vault: Vault, body: dict[str, Any], now: float) -> list[dict[str, Any]]:
    action = body.get("action")
    ids = body.get("ids")
    if (action not in ("approve", "reject", "undo") or not isinstance(ids, list) or not 1 <= len(ids) <= 12
            or not all(isinstance(ident, str) for ident in ids) or len(set(ids)) != len(ids)):
        raise VaultError("Choose valid AI proposals.")
    proposals = records(vault, now)
    by_id = {item["id"]: item for item in proposals}
    if any(ident not in by_id for ident in ids):
        raise VaultError("AI proposal not found.", 404)
    selected = [by_id[ident] for ident in ids]
    if len(selected) > 1 and (action != "approve" or any(item["tool"] != "create_note" for item in selected)):
        raise VaultError("Only new-note proposals can be approved together.")
    required = "approved" if action == "undo" else "pending"
    if any(item["status"] != required or item.get("undoneAt") for item in selected):
        raise VaultError("This proposal can no longer be reviewed.", 409)

    hidden = hidden_notes(vault)
    counters = usage(vault) if action == "approve" else None

    def persist(database) -> None:
        settings.save(vault, PROPOSALS, proposals, transaction=database)
        if counters is not None:
            settings.save(vault, "ai_usage", {**counters, "approvals": counters["approvals"] + len(selected)},
                          transaction=database)

    def applied(database, note: Note) -> None:
        original = selected[0]
        original.update(status="approved", noteId=note.id, appliedRevision=note.revision)
        persist(database)

    def undone(database, note: Note) -> None:
        selected[0]["undoneAt"] = now
        persist(database)

    item = selected[0]
    if action == "reject":
        item["status"] = "rejected"
        settings.save(vault, PROPOSALS, proposals)
    elif action == "undo":
        note = allowed(vault, item["noteId"], hidden)
        if note.revision != item["appliedRevision"]:
            raise VaultError("The note changed after approval. Use note history to review it.", 409)
        if item["tool"] == "create_note":
            has_attachments = any(asset["noteId"] == note.id for asset in vault.list_attachments())
            has_links = any(target == note.id for _, target in vault.graph()["edges"])
            if has_attachments or has_links or vault.entity(note.id)["revision"] or note.id in vault.pinned_notes() or note.id in vault.reminders():
                raise VaultError("This created note is now in use. Review it before moving it to Trash.", 409)
            vault.update_note(note.id, {"revision": note.revision, "trashed": True}, commit=undone)
        else:
            vault.restore_history(note.id, "note", item["previousRevision"], note.revision, commit=undone)
    elif item["tool"] == "create_note":
        keys = [title_key(entry["after"]["title"]) for entry in selected]
        if len(set(keys)) != len(keys):
            raise VaultError("Those proposals contain duplicate titles.", 409)

        def batch(database, notes: list[Note]) -> None:
            for entry, note in zip(selected, notes):
                entry.update(status="approved", noteId=note.id, appliedRevision=note.revision)
            persist(database)

        vault.create_notes([entry["after"] for entry in selected], commit=batch)
    else:
        note = allowed(vault, item["noteId"], hidden)
        related = item.get("related")
        if related and allowed(vault, related["id"], hidden).revision != related["revision"]:
            raise VaultError("The linked note changed. Request a fresh proposal.", 409)
        if note.revision != item["previousRevision"]:
            raise VaultError("The note changed. Reject this proposal and request a fresh one.", 409)
        vault.update_note(note.id, {"revision": note.revision, **item["after"]}, commit=applied)
    for entry in selected:
        audit(vault, entry["source"], action, tool=entry["tool"])
    return selected
