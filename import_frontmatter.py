"""Extract Obsidian aliases and tags while preserving the original Markdown."""

from __future__ import annotations

import re

import yaml

FRONTMATTER = re.compile(r"\A---[ \t]*\r?\n(.*?)^---[ \t]*(?:\r?\n|\Z)", re.MULTILINE | re.DOTALL)


def frontmatter_names(body: str) -> tuple[list[str], list[str], bool]:
    if not body.startswith(("---\n", "---\r\n")):
        return [], [], False
    match = FRONTMATTER.match(body[:32768])
    if not match:
        return [], [], True
    try:
        properties = yaml.load(match[1], Loader=yaml.BaseLoader)
    except (yaml.YAMLError, RecursionError):
        return [], [], True
    if properties is None:
        return [], [], False
    if not isinstance(properties, dict):
        return [], [], True

    def names(value: object, max_length: int) -> list[str]:
        values = value if isinstance(value, list) else [value]
        return [part.strip() for part in values if isinstance(part, str) and 0 < len(part.strip()) <= max_length]

    return names(properties.get("tags", properties.get("tag")), 36), names(
        properties.get("aliases", properties.get("alias")), 120), False
