"""Allowlisted, schema-checked tools. Writes return drafts for human review."""

from __future__ import annotations

from dataclasses import asdict
from typing import Any

from vault import MAX_BODY, NOTE_ID, Vault, VaultError, clean_title, note_tags
from .context import Context, allowed, hidden_notes
from .provider import ToolCall, ToolSpec

NOTE = {"type": "string", "pattern": "^[a-f0-9]{32}$"}
TEXT = {"type": "string", "minLength": 1, "maxLength": 8000}
TAG = {"type": "string", "minLength": 1, "maxLength": 60}


def spec(name, description, risk, **fields) -> ToolSpec:
    return ToolSpec(name, description, {"type": "object", "properties": fields, "required": list(fields),
                                        "additionalProperties": False}, risk)


TOOLS = {
    item.name: item for item in (
        spec("read_note", "Read the previewed excerpt of this note.", "read", note_id=NOTE),
        spec("search_notes", "Find text only within notes already in the approved preview.", "read", query=TAG),
        spec("list_tags", "List tags for notes in the approved preview.", "read"),
        spec("create_note", "Propose a new note.", "write", title={"type": "string", "minLength": 1, "maxLength": 120}, body=TEXT),
        spec("update_note", "Propose replacing a note body.", "write", note_id=NOTE, body=TEXT),
        spec("append_to_note", "Propose appending text.", "write", note_id=NOTE, text=TEXT),
        spec("add_tag", "Propose adding a tag.", "write", note_id=NOTE, tag=TAG),
        spec("link_notes", "Propose a link between two previewed notes.", "write", note_id=NOTE, target_id=NOTE),
        spec("replace_selection", "Propose a rewrite of the exact selected passage.", "write", note_id=NOTE, text=TEXT),
    )
}


def validate(call: ToolCall) -> ToolSpec:
    schema = TOOLS.get(call.name) if isinstance(call.name, str) else None
    if not schema or not isinstance(call.arguments, dict) or call.arguments.keys() != schema.parameters["properties"].keys():
        raise VaultError("Invalid or unavailable AI tool.", 400)
    for name, rule in schema.parameters["properties"].items():
        value = call.arguments[name]
        if not isinstance(value, str) or "../" in value.replace("\\", "/") or "\x00" in value:
            raise VaultError("Invalid AI tool argument.")
        if "pattern" in rule:
            if not NOTE_ID.fullmatch(value):
                raise VaultError("Invalid note identifier.")
        elif not value.strip() or not rule["minLength"] <= len(value) <= rule["maxLength"]:
            raise VaultError("An AI tool argument is outside its size limit.")
    return schema


def dispatch(vault: Vault, context: Context, call: ToolCall) -> tuple[ToolSpec, Any]:
    tool = validate(call)
    hidden = hidden_notes(vault)
    args = call.arguments

    def target(note_id: str):
        if note_id not in context.pages:
            raise VaultError("AI may use only notes explicitly included in the preview.", 403)
        note = allowed(vault, note_id, hidden)
        if note.revision != context.revisions[note_id]:
            raise VaultError("The preview is out of date.", 409)
        return note

    name = tool.name
    if name == "read_note":
        target(args["note_id"])
        return tool, asdict(context.pages[args["note_id"]])
    if name in ("search_notes", "list_tags"):
        visible = [chunk for chunk in context.pages.values()
                   if chunk.id not in hidden and chunk.id in vault.notes and not vault.notes[chunk.id].trashed]
        if name == "search_notes":
            return tool, [asdict(chunk) for chunk in visible if args["query"].casefold() in (chunk.title + "\n" + chunk.body).casefold()]
        return tool, sorted({tag for chunk in visible for tag in target(chunk.id).tags})

    if name == "create_note":
        title = clean_title(args["title"])
        vault._check_title(title)
        return tool, {"before": None, "after": {"title": title, "body": args["body"], "tags": []}}

    note = target(args["note_id"])
    before = {"title": note.title, "body": note.body, "tags": note.tags}
    if name == "update_note":
        next_body = args["body"]
    elif name == "append_to_note":
        next_body = note.body.rstrip("\n") + ("\n\n" if note.body else "") + args["text"].strip()
    elif name == "link_notes":
        other = target(args["target_id"])
        if other.id == note.id:
            raise VaultError("A note cannot link to itself through this tool.")
        label = other.title.replace("[", "").replace("]", "")
        next_body = note.body.rstrip("\n") + f"\n\n- [{label}](xotira:{other.id})"
    elif name == "replace_selection":
        if not context.selection or context.selection[0] != note.id:
            raise VaultError("A selection was not approved for this note.", 409)
        _, start, end = context.selection
        next_body = note.body[:start] + args["text"] + note.body[end:]
    else:
        next_body = note.body
    tags = note_tags(note.tags + [args["tag"]]) if name == "add_tag" else note.tags
    after = {**before, "body": next_body, "tags": tags}
    if len(next_body) > MAX_BODY or before == after:
        raise VaultError("The proposal is empty or too large.", 409)
    return tool, {"noteId": note.id, "previousRevision": note.revision,
                  "related": {"id": other.id, "revision": other.revision} if name == "link_notes" else None,
                  "before": before, "after": after}
