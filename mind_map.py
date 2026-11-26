"""Validation and serialization for Xotira mind-map attachments."""

from __future__ import annotations

import json
import math
import re
from collections import deque
from typing import Any
from uuid import uuid4

MIND_MAP_MAX_BYTES = 2 * 1024 * 1024
MIND_MAP_MAX_TOPICS = 500
MIND_MAP_MAX_LINKS = 500
MIND_MAP_MAX_DEPTH = 40
MIND_MAP_MAX_TITLE = 500
POSITION_LIMIT = 12_000
SHAPES = {"rectangle", "circle", "pill"}
COLORS = {"lavender", "blue", "teal", "orange", "pink", "cyan", "green", "purple"}
ID = re.compile(r"[a-f0-9]{32}\Z")


def valid_id(value: Any) -> bool:
    return isinstance(value, str) and ID.fullmatch(value) is not None


def new_map(title: str) -> dict[str, Any]:
    root = uuid4().hex
    return {"version": 1, "root": root, "topics": [
        {"id": root, "parent": None, "title": title, "note": "", "ref": None, "collapsed": False},
    ], "links": []}


def encode_map(raw: Any) -> tuple[bytes, str, list[str]]:
    if not isinstance(raw, dict) or type(raw.get("version")) is not int or raw["version"] != 1:
        raise ValueError("The mind map format is invalid.")
    root = raw.get("root")
    topics = raw.get("topics")
    links = raw.get("links")
    if not valid_id(root) or not isinstance(topics, list) or not 1 <= len(topics) <= MIND_MAP_MAX_TOPICS:
        raise ValueError("A mind map must contain 1–500 topics.")
    if not isinstance(links, list) or len(links) > MIND_MAP_MAX_LINKS:
        raise ValueError("A mind map can contain up to 500 cross-links.")
    by_id = {}
    children: dict[str, list[str]] = {}
    refs = set()
    for item in topics:
        if not isinstance(item, dict) or not valid_id(item.get("id")) or item["id"] in by_id:
            raise ValueError("Invalid topic ID.")
        topic_id = item["id"]
        parent = item.get("parent")
        title = item.get("title")
        note = item.get("note", "")
        ref = item.get("ref")
        collapsed = item.get("collapsed", False)
        shape = item.get("shape", "rectangle")
        side = item.get("side")
        offset = item.get("offset")
        if (topic_id == root and parent is not None) or (topic_id != root and not valid_id(parent)):
            raise ValueError("The parent topic is invalid.")
        if (not isinstance(title, str) or not 1 <= len(title.strip()) <= MIND_MAP_MAX_TITLE
                or any(ord(ch) < 32 for ch in title)):
            raise ValueError(f"A topic name must be 1–{MIND_MAP_MAX_TITLE} characters.")
        if not isinstance(note, str) or len(note) > 1800:
            raise ValueError("Topic notes can contain up to 1,800 characters.")
        if ref is not None:
            if not valid_id(ref):
                raise ValueError("The note link is invalid.")
            refs.add(ref)
        if type(collapsed) is not bool:
            raise ValueError("Invalid branch state.")
        by_id[topic_id] = {"id": topic_id, "parent": parent, "title": title.strip(), "note": note,
                           "ref": ref, "collapsed": collapsed}
        if not isinstance(shape, str) or shape not in SHAPES:
            raise ValueError("Unknown topic shape.")
        if shape != "rectangle":
            by_id[topic_id]["shape"] = shape
        if "color" in item:
            color = item["color"]
            if not isinstance(color, str) or color not in COLORS:
                raise ValueError("Unknown topic color.")
            by_id[topic_id]["color"] = color
        if "side" in item:
            if parent != root or side not in ("left", "right"):
                raise ValueError("Invalid branch side.")
            by_id[topic_id]["side"] = side
        if offset is not None:
            if (not isinstance(offset, list) or len(offset) != 2
                    or any(type(coord) not in (int, float) or abs(coord) > POSITION_LIMIT
                           or not math.isfinite(coord) for coord in offset)):
                raise ValueError("Invalid topic position.")
            if offset != [0, 0]:
                by_id[topic_id]["offset"] = offset
        if parent is not None:
            children.setdefault(parent, []).append(topic_id)

    if root not in by_id:
        raise ValueError("The main topic is missing.")
    queue = deque([(root, 0)])
    visited = 0
    while queue:
        node, depth = queue.popleft()
        if depth > MIND_MAP_MAX_DEPTH:
            raise ValueError("Branch depth cannot exceed 40 levels.")
        visited += 1
        queue.extend((child, depth + 1) for child in children.get(node, []))
    if visited != len(by_id):
        raise ValueError("Connect every branch to the main topic.")

    cleaned_links = []
    seen = set()
    for link in links:
        if not isinstance(link, dict) or not valid_id(link.get("a")) or not valid_id(link.get("b")):
            raise ValueError("Invalid cross-link.")
        a, b = link["a"], link["b"]
        key = tuple(sorted((a, b)))
        if a not in by_id or b not in by_id or a == b or key in seen:
            raise ValueError("The link is duplicated or one of its topics is missing.")
        seen.add(key)
        cleaned_links.append({"a": a, "b": b})

    clean = {"version": 1, "root": root, "topics": list(by_id.values()), "links": cleaned_links}
    try:
        content = (json.dumps(clean, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    except UnicodeError as error:
        raise ValueError("The mind map contains an invalid character.") from error
    if len(content) > MIND_MAP_MAX_BYTES:
        raise ValueError("A mind map can be up to 2 MiB.")
    return content, by_id[root]["title"], sorted(refs)
