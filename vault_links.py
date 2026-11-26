"""Resolve Obsidian-style links against paths in an imported collection."""

from __future__ import annotations

import posixpath
import re
from collections import defaultdict
from dataclasses import dataclass
from urllib.parse import unquote

WIKILINK = re.compile(r"\[\[([^\[\]\n|#]+?)(?:#[^\[\]\n|]*?)?(?:\\?\|[^\[\]\n]*)?\]\]")
MARKDOWN_LINK = re.compile(
    r"!?\[(?:[^\[\]\\]|\\.)*\]\(\s*(?:<(?P<angle>[^>\n]+)>|"
    r"(?P<plain>(?:\\.|[^\s()\\]|\([^()\n]*\))+))"
    r"""(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)"""
)
DEFINITION = re.compile(r"^ {0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*:", re.I)
STABLE_ID = re.compile(r"(xotira|attachment):([0-9a-f]{32})$")


def prose_lines(body: str):
    fence = ""
    for line in body.splitlines():
        opening = FENCE.match(line)
        if opening:
            token = opening[1]
            if not fence:
                fence = token
            elif token.startswith(fence) and not line[opening.end():].strip():
                fence = ""
            continue
        if not fence and not line.startswith(("    ", "\t")):
            yield from re.split(r"(`+[^`\n]*`+)", line)[::2]


def references(body: str) -> set[tuple[str, str]]:
    targets: set[tuple[str, str]] = set()
    for line in prose_lines(body):
        targets.update(("wiki", match[1].strip()) for match in WIKILINK.finditer(line))
        targets.update(("md", match["angle"] or match["plain"]) for match in MARKDOWN_LINK.finditer(line))
        if match := DEFINITION.match(line):
            targets.add(("md", match[1] or match[2]))
    return targets


@dataclass(frozen=True)
class Target:
    id: str
    label: str
    source: str = ""
    path: str = ""
    kind: str = "note"
    owner: str = ""


class LinkIndex:
    def __init__(self, notes, files, normalize):
        self.normalize = normalize
        self.paths = defaultdict(set)
        self.suffixes = defaultdict(set)
        self.titles = defaultdict(set)
        self.targets: dict[str, Target] = {}
        self.attached = defaultdict(set)
        for note in notes:
            target = Target(note.id, note.title, note.source, note.path)
            self.add(target, (note.title, *note.aliases))
        for file in files:
            target = Target(file["id"], file["name"], file.get("source", ""), file.get("path", ""),
                            "file", file["noteId"])
            self.add(target, (file["name"],))
            if not file.get("managed"):
                self.attached[file["noteId"]].add(target.id)

    def add(self, target: Target, titles):
        self.targets[target.id] = target
        scope = self.normalize(target.source)
        for title in titles:
            normalized = self.normalize(title)
            self.titles[scope, normalized].add(target.id)
            self.titles[None, normalized].add(target.id)
        if not target.path:
            return
        path = self.normalize(target.path)
        names = [path]
        if target.kind == "note":
            names.append(posixpath.splitext(path)[0])
        for name in names:
            self.paths[scope, name].add(target.id)
            segments = name.split("/")
            for index in range(len(segments)):
                self.suffixes[scope, "/".join(segments[index:])].add(target.id)
                self.suffixes[None, "/".join(segments[index:])].add(target.id)

    def resolve(self, note, kind: str, reference: str) -> str | None:
        raw = reference.strip()
        if match := STABLE_ID.fullmatch(raw):
            key = match[2]
            found = self.targets.get(key)
            expected = "note" if match[1] == "xotira" else "file"
            return key if found and found.kind == expected else None
        if SCHEME.match(raw) or raw.startswith("//"):
            return None
        name = raw.split("#", 1)[0]
        if kind == "md":
            name = re.sub(r"\\([() ])", r"\1", unquote(name))
        if not name:
            return None

        scope = self.normalize(note.source)
        parent = posixpath.dirname(note.path)
        relative = posixpath.normpath(posixpath.join(parent, name.lstrip("/")))
        absolute = posixpath.normpath(name.lstrip("/"))
        keys = [absolute, relative] if (name.startswith("/") or kind == "wiki" and "/" in name and not name.startswith(".")) else [relative, absolute]
        if name.startswith(("./", "../")):
            keys = [relative]
        for candidate in dict.fromkeys(keys):
            hits = self.paths.get((scope, self.normalize(candidate)), set())
            if hits:
                return next(iter(hits)) if len(hits) == 1 else None
        if name.startswith(("./", "../", "/")):
            return None

        short = self.normalize(name)
        same = self.suffixes.get((scope, short), set()) | self.titles.get((scope, short), set())
        owned = (same | self.titles.get((None, short), set())) & self.attached[note.id]
        if owned:
            return next(iter(owned)) if len(owned) == 1 else None
        if same:
            return next(iter(same)) if len(same) == 1 else None
        if note.source:
            return None
        across = self.suffixes.get((None, short), set()) | self.titles.get((None, short), set())
        return next(iter(across)) if len(across) == 1 else None

    def links_for(self, note) -> dict[str, str]:
        found: dict[str, str] = {}
        for kind, reference in references(note.body):
            target = self.resolve(note, kind, reference)
            if target:
                found[kind + ":" + reference] = target
                if kind == "md":
                    found[kind + ":" + re.sub(r"\\([() ])", r"\1", reference)] = target
        return found
