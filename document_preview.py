"""Read bounded Office Open XML and OpenDocument previews without extracting any files."""

from __future__ import annotations

import base64
import io
import posixpath
import re
from pathlib import Path
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

from vault import VaultError

MAX_XML = 3 * 1024 * 1024
MAX_TEXT = 120_000
MAX_SECTIONS = 50
MAX_ROWS = 100
MAX_COLUMNS = 30
MAX_IMAGE_BYTES = 700_000
MAX_PREVIEW_IMAGE_BYTES = 2_100_000
IMAGE_FORMATS = {".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".gif": "gif", ".webp": "webp"}
PRESENTATION_SLIDE = re.compile(r"ppt/slides/slide(\d+)\.xml")
WORKSHEET = re.compile(r"xl/worksheets/sheet(\d+)\.xml")
OFFICE_FORMATS = {
    ".docx": "word", ".docm": "word", ".pptx": "slides", ".pptm": "slides",
    ".xlsx": "sheets", ".xlsm": "sheets", ".odt": "odf", ".ods": "odf", ".odp": "odf",
}


def xml_member(archive: ZipFile, name: str) -> ElementTree.Element:
    try:
        member = archive.getinfo(name)
    except KeyError as error:
        raise VaultError("Part of the document is missing.", 422) from error
    if member.file_size > MAX_XML:
        raise VaultError("Part of the document is too large to preview.", 422)
    with archive.open(member) as handle:
        content = handle.read(MAX_XML + 1)
    if len(content) > MAX_XML or b"\x00" in content or re.search(br"<!\s*(?:DOCTYPE|ENTITY)\b", content, re.I):
        raise VaultError("The document XML cannot be previewed.", 422)
    return ElementTree.fromstring(content)


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def paragraph_text(paragraph: ElementTree.Element) -> str:
    pieces = []
    for item in paragraph.iter():
        kind = local_name(item.tag)
        if kind == "t":
            pieces.append(item.text or "")
        elif kind in ("br", "cr"):
            pieces.append("\n")
        elif kind == "tab":
            pieces.append("\t")
    return "".join(pieces)


def paragraphs(root: ElementTree.Element) -> str:
    return "\n".join(paragraph_text(item) for item in root.iterfind(".//{*}p"))[:MAX_TEXT].strip()


def images_for(archive: ZipFile, path: str, media_prefix: str) -> dict[str, str]:
    directory, name = posixpath.split(path)
    relation_path = posixpath.join(directory, "_rels", name + ".rels")
    if relation_path not in archive.namelist():
        return {}
    relationships = xml_member(archive, relation_path)
    targets = {}
    for relation in relationships:
        if not relation.get("Type", "").endswith("/image") or relation.get("TargetMode", "").lower() == "external":
            continue
        target = posixpath.normpath(posixpath.join(directory, relation.get("Target", "")))
        if target.startswith(media_prefix):
            targets[relation.get("Id", "")] = target
    return targets


def image_blocks(archive: ZipFile, container: ElementTree.Element, targets: dict[str, str],
                 budget: list[int]) -> list[dict]:
    output = []
    for node in container.iter():
        if local_name(node.tag) not in ("blip", "imagedata") or not budget[0]:
            continue
        ident = next((value for key, value in node.attrib.items() if local_name(key) in ("embed", "id")), "")
        target = targets.get(ident, "")
        mime = IMAGE_FORMATS.get(Path(target).suffix.lower())
        if not mime:
            continue
        try:
            file = archive.getinfo(target)
        except KeyError:
            continue
        if not 0 < file.file_size <= min(MAX_IMAGE_BYTES, budget[0]):
            continue
        with archive.open(file) as image:
            data = image.read(MAX_IMAGE_BYTES + 1)
        if len(data) != file.file_size:
            continue
        budget[0] -= len(data)
        output.append({"image": f"data:image/{mime};base64," + base64.b64encode(data).decode("ascii")})
    return output


def word_sections(archive: ZipFile, root: ElementTree.Element, budget: list[int]) -> list[dict]:
    targets = images_for(archive, "word/document.xml", "word/media/")
    container = root.find("{*}body")
    if container is None:
        return []
    blocks = []
    text = []
    size = 0
    for item in container:
        tag = local_name(item.tag)
        if tag == "p":
            paragraph = paragraph_text(item)[:MAX_TEXT - size]
            style_node = item.find("./{*}pPr/{*}pStyle")
            style = "" if style_node is None else next(iter(style_node.attrib.values()), "")
            heading = re.fullmatch(r"heading([1-6])", style.replace(" ", ""), re.I)
            blocks.append({"text": paragraph, "level": int(heading[1]) if heading else 0})
            if targets:
                blocks.extend(image_blocks(archive, item, targets, budget))
            text.append(paragraph)
            size += len(paragraph) + 1
        elif tag == "tbl":
            rows = []
            for row in item.findall("{*}tr")[:MAX_ROWS]:
                cells = []
                for cell in row.findall("{*}tc")[:MAX_COLUMNS]:
                    value = paragraphs(cell)[:min(1000, MAX_TEXT - size)]
                    cells.append(value)
                    size += len(value) + 1
                    if size >= MAX_TEXT:
                        break
                rows.append(cells)
                text.append(" | ".join(cells))
                if size >= MAX_TEXT:
                    break
            blocks.append({"rows": rows})
        if size >= MAX_TEXT or len(blocks) >= 2500:
            break
    result = {"text": "\n".join(text)}
    if any("rows" in block or "image" in block or block.get("level") for block in blocks):
        result["blocks"] = blocks
    return [result]


def odf_content(root: ElementTree.Element, suffix: str) -> list[dict]:
    remaining = MAX_TEXT

    def lines(container: ElementTree.Element) -> str:
        nonlocal remaining
        output = []
        for item in container.iter():
            if local_name(item.tag) in ("p", "h"):
                text = "".join(item.itertext())[:remaining]
                output.append(text)
                remaining -= len(text) + 1
                if remaining <= 0:
                    break
        return "\n".join(output)

    if suffix == ".odt":
        return [{"text": lines(root)}]
    tag = "page" if suffix == ".odp" else "table"
    output = []
    for index, document in enumerate(root.findall(f".//{{*}}{tag}")[:MAX_SECTIONS], 1):
        name = next((value for key, value in document.attrib.items() if local_name(key) == "name"), "")
        title = name[:120] or f"{'Slide' if tag == 'page' else 'Sheet'} {index}"
        if tag == "page":
            output.append({"title": title, "text": lines(document)})
        else:
            rows = []
            for row in document.findall(".//{*}table-row")[:MAX_ROWS]:
                values = [lines(cell) if remaining > 0 else "" for cell in list(row)[:MAX_COLUMNS]]
                if any(values):
                    rows.append(values)
                if remaining <= 0:
                    break
            output.append({"title": title, "rows": rows})
        if remaining <= 0:
            break
    return output


def numbered_members(archive: ZipFile, pattern: re.Pattern[str]) -> list[tuple[int, str]]:
    members = ((pattern.fullmatch(name), name) for name in archive.namelist())
    return sorted((int(match[1]), name) for match, name in members if match)[:MAX_SECTIONS]


def workbook(archive: ZipFile) -> list[dict]:
    shared = []
    if "xl/sharedStrings.xml" in archive.namelist():
        root = xml_member(archive, "xl/sharedStrings.xml")
        shared = ["".join(text.text or "" for text in item.iterfind(".//{*}t"))
                  for item in root.findall("{*}si")]
    sections = []
    remaining = MAX_TEXT
    for number, path in numbered_members(archive, WORKSHEET):
        root = xml_member(archive, path)
        rows = []
        for source in root.findall(".//{*}row")[:MAX_ROWS]:
            cells = []
            for cell in source.findall("{*}c")[:MAX_COLUMNS]:
                value = cell.findtext("{*}v", "")
                kind = cell.get("t")
                if kind == "s" and value.isdigit() and int(value) < len(shared):
                    value = shared[int(value)]
                elif kind == "inlineStr":
                    value = "".join(text.text or "" for text in cell.iterfind(".//{*}t"))
                address = cell.get("r", "")[:10]
                if value and remaining > 0:
                    value = value[:min(1000, remaining)]
                    cells.append(f"{address}: {value}" if address else value)
                    remaining -= len(value) + 12
            if cells:
                rows.append(cells)
            if remaining <= 0:
                break
        sections.append({"title": f"Varaq {number}", "rows": rows})
        if remaining <= 0:
            break
    return sections


def preview_office(name: str, data: bytes) -> dict:
    suffix = Path(name).suffix.lower()
    kind = OFFICE_FORMATS.get(suffix)
    if kind is None:
        raise VaultError("This document format does not support a preview.", 415)
    try:
        with ZipFile(io.BytesIO(data)) as archive:
            image_budget = [MAX_PREVIEW_IMAGE_BYTES]
            if kind == "word":
                sections = word_sections(archive, xml_member(archive, "word/document.xml"), image_budget)
            elif kind == "odf":
                sections = odf_content(xml_member(archive, "content.xml"), suffix)
            elif kind == "slides":
                sections = []
                remaining = MAX_TEXT
                for number, path in numbered_members(archive, PRESENTATION_SLIDE):
                    root = xml_member(archive, path)
                    text = paragraphs(root)[:remaining]
                    section = {"title": f"Slayd {number}", "text": text}
                    targets = images_for(archive, path, "ppt/media/")
                    figures = image_blocks(archive, root, targets, image_budget) if targets else []
                    if figures:
                        section["blocks"] = [{"text": text}, *figures]
                    sections.append(section)
                    remaining -= len(text)
                    if remaining <= 0:
                        break
            else:
                sections = workbook(archive)
    except (BadZipFile, ElementTree.ParseError, OSError, RuntimeError, NotImplementedError) as error:
        raise VaultError("Memory map could not read the document.", 422) from error
    return {"sections": sections}
