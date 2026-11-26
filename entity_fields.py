"""Validation for structured note fields and typed relationship values."""

from __future__ import annotations

import re
from datetime import date
from typing import Any, TypedDict

NOTE_ID = re.compile(r"[a-f0-9]{32}\Z")
DATE = re.compile(r"\d{4}-\d{2}-\d{2}\Z", re.ASCII)
ENTITY_TYPES = ("note", "concept", "person", "project", "task", "paper", "book",
                "meeting", "organization", "document", "goal", "event", "client", "source")
RELATION_TYPES = ("related_to", "belongs_to", "depends_on", "blocks", "cites",
                  "authored_by", "participates_in", "derived_from", "parent_of")
CHOICES = {
    "status": ("note", "todo", "doing", "done"),
    "priority": ("", "high", "med", "low"),
    "cover": ("", "cov-1", "cov-2", "cov-3", "cov-4", "cov-5"),
    "type": ENTITY_TYPES,
}
LEGACY_FIELDS = frozenset(("status", "priority", "due", "icon", "cover"))


class Relationship(TypedDict):
    type: str
    target: str


def clean_field(name: str, value: Any) -> str | list[Relationship]:
    if name == "relationships":
        if not isinstance(value, list) or len(value) > 200:
            raise ValueError(name)
        relations: list[Relationship] = []
        seen: set[tuple[str, str]] = set()
        for entry in value:
            if not isinstance(entry, dict):
                raise ValueError(name)
            kind, target = entry.get("type"), entry.get("target")
            if kind not in RELATION_TYPES or not isinstance(target, str) or not NOTE_ID.fullmatch(target):
                raise ValueError(name)
            if (kind, target) not in seen:
                relations.append({"type": kind, "target": target})
                seen.add((kind, target))
        return relations
    if not isinstance(value, str):
        raise ValueError(name)
    if name in CHOICES and value in CHOICES[name]:
        return value
    if name == "icon" and len(value) <= 64 and all(char.isprintable() for char in value):
        value.encode("utf-8")
        return value
    if name == "due":
        if not value:
            return value
        if DATE.fullmatch(value):
            date.fromisoformat(value)
            return value
    raise ValueError(name)
