"""Build a bounded, revisioned snapshot of what a user chose to show the AI."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import settings
from vault import NOTE_ID, Note, Vault, VaultError
from vault_links import LinkIndex
from vault import title_key
from .provider import AIMessage

VISIBILITY = "note_ai_visibility"
ACTION_FILE = {"rewrite": "rewrite", "summarize": "summarize", "translate": "translate",
               "grammar": "fix_grammar", "shorter": "shorter", "wizard": "build_system"}
ACTIONS = {"chat", *ACTION_FILE}
CONTEXT_LIMIT = 12_000
RESULTS_LIMIT = 4
PROMPTS = Path(__file__).with_name("prompts")


@dataclass(frozen=True)
class Chunk:
    id: str
    title: str
    body: str
    kind: str


@dataclass
class Context:
    messages: list[AIMessage]
    pages: dict[str, Chunk]
    revisions: dict[str, int]
    cuts: list[str] = field(default_factory=list)
    selection: tuple[str, int, int] | None = None


def hidden_notes(vault: Vault) -> set[str]:
    return set(settings.load(vault, VISIBILITY, [])) | vault.protected_note_ids()


def allowed(vault: Vault, note_id: str, hidden: set[str]) -> Note:
    note = vault.notes.get(note_id)
    if note is None or note.trashed or note.storage_only or note_id in hidden:
        raise VaultError("This note is unavailable to AI.", 403)
    return note


def retrieve(query: str, notes: list[Note]) -> list[Note]:
    terms = query.casefold().split()[:12]
    if not terms:
        return []
    return [note for note in notes if all(term in (note.title + "\n" + note.body).casefold() for term in terms)][:RESULTS_LIMIT]


def configure_visibility(vault: Vault, note_id: Any, value: Any) -> str:
    if not isinstance(note_id, str) or not NOTE_ID.fullmatch(note_id) or value not in ("allowed", "never"):
        raise VaultError("Invalid note visibility.")
    vault.require_note_unlocked(note_id)
    if note_id not in vault.notes or vault.notes[note_id].storage_only:
        raise VaultError("Note not found.", 404)
    private = {ident for ident in settings.load(vault, VISIBILITY, []) if ident in vault.notes}
    if value == "never":
        private.add(note_id)
    else:
        private.discard(note_id)
    settings.save(vault, VISIBILITY, sorted(private))
    return value


def build_context(vault: Vault, body: dict[str, Any], limit: int) -> Context:
    action = body.get("action", "chat")
    prompt, note_id, selection = body.get("prompt", ""), body.get("noteId", ""), body.get("selection", "")
    query = body.get("search", "")
    if (not isinstance(action, str) or action not in ACTIONS or not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 4000
            or not isinstance(note_id, str) or (note_id and not NOTE_ID.fullmatch(note_id))
            or not isinstance(selection, str) or len(selection) > 6000 or not isinstance(query, str) or len(query) > 300):
        raise VaultError("Enter a valid AI request and selection.")
    locale = body.get("language")
    language = locale if locale in ("en", "uz", "ru", "tr", "es", "ar") else "en"
    excluded = hidden_notes(vault)
    notes = [note for note in vault.notes.values() if not note.trashed and not note.storage_only and note.id not in excluded]
    current = next((note for note in notes if note.id == note_id), None)
    cuts = ["private_current"] if note_id and not current else []
    picked: list[tuple[Note, str]] = [(current, "current")] if current else []
    if current and body.get("includeLinked") is True:
        index = LinkIndex(notes, [], title_key)
        linked = sorted(set(index.links_for(current).values()) - {current.id})
        picked.extend((vault.notes[ident], "linked") for ident in linked[:RESULTS_LIMIT])
        if len(linked) > RESULTS_LIMIT:
            cuts.append("linked_limit")
    if query.strip():
        picked.extend((note, "search") for note in retrieve(query, notes))

    span = None
    if selection and current:
        start = current.body.find(selection)
        if start < 0 or current.body.find(selection, start + 1) >= 0:
            raise VaultError("Select a unique passage in the Markdown source before applying an AI edit.", 409)
        span = (current.id, start, start + len(selection))
    selection_action = action in {"rewrite", "summarize", "translate", "grammar", "shorter"}
    if selection_action and not span:
        raise VaultError("Select text in a note that allows AI context.", 409)

    header = (PROMPTS / "system_base.md").read_text("utf-8")
    if action in ACTION_FILE:
        header += "\n" + (PROMPTS / (ACTION_FILE[action] + ".md")).read_text("utf-8")
    direct = json.dumps({"action": action, "language": language, "prompt": prompt.strip()}, ensure_ascii=False)
    def escaped_size(value: str) -> int:
        return len(json.dumps(value, ensure_ascii=False, separators=(",", ":"))) - 2

    def encode(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    budget = min(limit, CONTEXT_LIMIT) - escaped_size(header) - escaped_size(direct)
    data = {"notes": [], "selection": selection if span else ""}
    if escaped_size(encode(data)) > budget:
        raise VaultError("The request is above its size cap. Shorten the prompt or selection.", 413)
    pages = {}
    revisions = {}
    for note, kind in picked:
        if note.id in pages:
            continue
        row = {"id": note.id, "title": note.title, "body": "", "kind": kind}
        data["notes"].append(row)
        if escaped_size(encode(data)) > budget:
            data["notes"].pop()
            cuts.append(kind + "_limit")
            continue
        available = len(note.body)
        row["body"] = note.body[:min(available, budget)]
        if escaped_size(encode(data)) > budget:
            low, high = 0, len(row["body"])
            while low < high:
                midpoint = (low + high + 1) // 2
                row["body"] = note.body[:midpoint]
                if escaped_size(encode(data)) <= budget:
                    low = midpoint
                else:
                    high = midpoint - 1
            row["body"] = note.body[:low]
        if len(row["body"]) < available:
            cuts.append(kind + "_trimmed")
        pages[note.id] = Chunk(**row)
        revisions[note.id] = note.revision
    if span and span[0] not in pages:
        raise VaultError("The selection could not fit in the request.", 413)
    payload = encode(data)
    return Context([AIMessage("system", header), AIMessage("user", direct),
                    AIMessage("user", payload, untrusted=True)], pages, revisions, list(dict.fromkeys(cuts)), span)
