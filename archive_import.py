"""Read supported ZIP exports without extracting files to the filesystem."""

from __future__ import annotations

import csv
import io
import json
import re
import stat
from collections.abc import Iterator
from html.parser import HTMLParser
from zipfile import BadZipFile, ZipFile

from folder_import import MAX_ENTRIES, MAX_IMPORT, valid_part
from vault import MAX_ATTACHMENT, MAX_BODY, VaultError

HTML_MARKERS = {"p": "", "li": "- ", "blockquote": "> ", **{f"h{i}": "#" * i + " " for i in range(1, 7)}}
MAX_CSV_ROWS = 500
MAX_CSV_COLUMNS = 100
HIDDEN_HTML = {"script", "style", "head", "iframe", "svg", "template"}


class PlainPage(HTMLParser):
    """Keep readable text and ordinary local links from Notion HTML pages."""

    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.hidden: list[str] = []
        self.href = ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in HIDDEN_HTML:
            self.hidden.append(tag)
        if self.hidden:
            return
        if tag in HTML_MARKERS:
            self.parts.append("\n\n" + HTML_MARKERS[tag])
        elif tag == "br":
            self.parts.append("\n")
        elif tag == "a":
            href = dict(attrs).get("href") or ""
            if href and re.match(r"(?i)(?:https?://|mailto:|[^:/#]+(?:/|#|$)|#)", href):
                self.href = href.replace(" ", "%20").replace("(", "%28").replace(")", "%29")
                self.href = self.href.splitlines()[0]
                self.parts.append("[")
        elif tag == "img":
            src = dict(attrs).get("src") or ""
            if src and not re.match(r"[a-zA-Z][\w+.-]*:", src):
                target = src.replace(" ", "%20").replace("(", "%28").replace(")", "%29")
                if not any(char in target for char in "\r\n"):
                    self.parts.append("![Rasm](" + target + ")")

    def handle_endtag(self, tag: str) -> None:
        if self.hidden:
            if tag == self.hidden[-1]:
                self.hidden.pop()
            return
        if tag == "a" and self.href:
            self.parts.append("](" + self.href + ")")
            self.href = ""
        elif tag in ("td", "th"):
            self.parts.append(" | ")
        elif tag in ("div", "tr", "hr", "section", "article"):
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.hidden:
            self.parts.append(re.sub(r"\s+", " ", data))

    def markdown(self) -> str:
        return re.sub(r"\n{3,}", "\n\n", "".join(self.parts)).strip() + "\n"


def notion_rows(path: str, content: bytes) -> list[tuple[str, bytes]] | None:
    """Project a bounded Notion CSV into notes while retaining the original CSV."""
    if len(content) > 4 * 1024**2:
        return None
    try:
        reader = csv.reader(io.StringIO(content.decode("utf-8-sig"), newline=""), strict=True)
        headers = next(reader, [])
        if not 0 < len(headers) <= MAX_CSV_COLUMNS or len(headers) != len(set(headers)):
            return None
        result = []
        base = path.rsplit(".", 1)[0]
        for index, row in enumerate(reader, 1):
            if index > MAX_CSV_ROWS or len(row) != len(headers):
                return None
            properties = dict(zip(headers, row))
            title = re.sub(r"[<>:/\\|?*#\[\]\x00-\x1f]", "_", row[0]).strip(" .")[:85] or "Row"
            dest = f"{base} - rows/{title} ({index}).md"
            if len(dest) > 1800 or not all(valid_part(part) for part in dest.split("/")):
                return None
            values = "\n".join(
                f"{json.dumps(name, ensure_ascii=False)}: {json.dumps(value, ensure_ascii=False)}"
                for name, value in properties.items()
            )
            body = f"---\n{values}\n---\n"
            if len(body) > MAX_BODY:
                return None
            result.append((dest, body.encode("utf-8")))
        return result
    except (UnicodeError, csv.Error):
        return None


def zip_entries(archive: ZipFile, *, notion: bool, summary: dict[str, int]) -> Iterator[tuple[str, bytes]]:
    members = archive.infolist()
    if len(members) > MAX_ENTRIES * 2:
        raise VaultError("The ZIP contains too many entries.")
    entries = {}
    total = 0
    for item in members:
        if item.is_dir():
            continue
        name = item.filename
        parts = name.split("/")
        if name.startswith("/") or "\\" in name or any(part in {"", ".", ".."} for part in parts):
            raise VaultError("The ZIP contains an invalid file path.")
        if any(part.startswith(".") for part in parts) or parts[0] == "__MACOSX":
            summary["skipped"] += 1
            continue
        if len(name) > 1800 or not all(valid_part(part) for part in parts):
            raise VaultError("The ZIP contains an invalid file path.")
        if item.flag_bits & 1 or stat.S_ISLNK(item.external_attr >> 16):
            raise VaultError("The ZIP contains a protected file or a symbolic link.")
        if name in entries or item.file_size > MAX_ATTACHMENT:
            raise VaultError("The ZIP contains a duplicate path or a file larger than 64 MiB.")
        total += item.file_size
        if len(entries) >= MAX_ENTRIES or total > MAX_IMPORT:
            raise VaultError("The ZIP can contain up to 20,000 files and 2 GiB of data.", 413)
        entries[name] = item
    if not entries:
        raise VaultError("No importable files found in the ZIP.")
    used = set(entries)
    remaining = MAX_ENTRIES - len(entries)
    for name, item in entries.items():
        try:
            content = archive.read(item)
        except (BadZipFile, NotImplementedError, RuntimeError, EOFError) as error:
            raise VaultError("Could not read a file in the ZIP.") from error
        yield name, content
        lower = name.lower()
        if not notion:
            continue
        if lower.endswith(".zip"):
            summary["unconverted"] += 1
        if lower.endswith(".csv"):
            rows = notion_rows(name, content)
            if rows is None or len(rows) > remaining or any(path in used for path, _ in rows):
                summary["unconverted"] += 1
                continue
            for path, body in rows:
                yield path, body
                used.add(path)
            remaining -= len(rows)
            summary["csvRows"] = summary.get("csvRows", 0) + len(rows)
        if not lower.endswith((".html", ".htm")):
            continue
        target = name.rsplit(".", 1)[0] + ".md"
        if target in used or not remaining:
            summary["unconverted"] += 1
            continue
        try:
            parser = PlainPage()
            parser.feed(content.decode("utf-8-sig"))
            parser.close()
        except (UnicodeError, ValueError):
            summary["unconverted"] += 1
            continue
        markdown = parser.markdown()
        if len(markdown) > MAX_BODY:
            summary["unconverted"] += 1
            continue
        yield target, markdown.encode("utf-8")
        remaining -= 1
        used.add(target)
        summary["converted"] += 1
