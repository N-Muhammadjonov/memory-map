"""Zero-dependency DOCX, EPUB 3 export and BibTeX citation parser for Xotira."""

from __future__ import annotations

import html
import io
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile

from vault import Note, VaultError

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
XML_NS = "http://www.w3.org/XML/1998/namespace"


def _strip_frontmatter(body: str) -> str:
    return re.sub(r"^---\r?\n[\s\S]*?\r?\n---\r?\n*", "", body, count=1)


def _plain_inline(text: str) -> str:
    text = re.sub(r"\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]", lambda m: m.group(2) or m.group(1), text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"[*_~`]|==", "", text)
    return text.strip()


def export_note_docx(note: Note) -> bytes:
    """Generate a valid OOXML .docx document directly from a Xotira note."""
    doc_el = ET.Element(f"{{{W_NS}}}document")
    body_el = ET.SubElement(doc_el, f"{{{W_NS}}}body")

    def add_para(text: str, *, bold: bool = False, size_half_pts: int = 22, mono: bool = False) -> None:
        p = ET.SubElement(body_el, f"{{{W_NS}}}p")
        r = ET.SubElement(p, f"{{{W_NS}}}r")
        rpr = ET.SubElement(r, f"{{{W_NS}}}rPr")
        if bold:
            ET.SubElement(rpr, f"{{{W_NS}}}b")
        sz = ET.SubElement(rpr, f"{{{W_NS}}}sz")
        sz.set(f"{{{W_NS}}}val", str(size_half_pts))
        if mono:
            fonts = ET.SubElement(rpr, f"{{{W_NS}}}rFonts")
            fonts.set(f"{{{W_NS}}}ascii", "Courier New")
            fonts.set(f"{{{W_NS}}}hAnsi", "Courier New")
        t = ET.SubElement(r, f"{{{W_NS}}}t")
        t.set(f"{{{XML_NS}}}space", "preserve")
        t.text = text

    add_para(note.title, bold=True, size_half_pts=36)
    if note.tags:
        add_para("Tags: " + ", ".join(f"#{tag}" for tag in note.tags), size_half_pts=18)

    in_code = False
    for raw_line in _strip_frontmatter(note.body).replace("\r\n", "\n").split("\n"):
        if re.match(r"^ {0,3}(?:`{3,}|~{3,})", raw_line):
            in_code = not in_code
            continue
        if in_code:
            add_para(raw_line or " ", size_half_pts=19, mono=True)
            continue
        line = raw_line.strip()
        if not line:
            continue
        heading = re.match(r"^(#{1,6})\s+(.+)$", line)
        if heading:
            level = len(heading.group(1))
            size = max(24, 34 - level * 2)
            add_para(_plain_inline(heading.group(2)), bold=True, size_half_pts=size)
        elif re.match(r"^[-+*]\s+\[([ xX])\]\s+", line):
            m = re.match(r"^[-+*]\s+\[([ xX])\]\s+(.*)$", line)
            mark = "[x]" if m and m.group(1) != " " else "[ ]"
            add_para(f"{mark} {_plain_inline(m.group(2) if m else line)}")
        elif re.match(r"^[-+*]\s+", line):
            add_para("• " + _plain_inline(re.sub(r"^[-+*]\s+", "", line)))
        else:
            add_para(_plain_inline(line))

    ET.register_namespace("w", W_NS)
    document_xml = b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + ET.tostring(doc_el, encoding="utf-8")

    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        "</Types>"
    ).encode("utf-8")

    rels_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="word/document.xml"/>'
        "</Relationships>"
    ).encode("utf-8")

    buf = io.BytesIO()
    with ZipFile(buf, "w", ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", rels_xml)
        archive.writestr("word/document.xml", document_xml)
    return buf.getvalue()


def export_note_epub(note: Note) -> bytes:
    """Generate a valid EPUB 3 e-book directly from a Xotira note."""
    book_id = f"urn:uuid:{uuid4()}"
    title_esc = html.escape(note.title)
    modified = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    blocks: list[str] = [f"<h1>{title_esc}</h1>"]
    in_code = False
    code_buf: list[str] = []
    for raw_line in _strip_frontmatter(note.body).replace("\r\n", "\n").split("\n"):
        if re.match(r"^ {0,3}(?:`{3,}|~{3,})", raw_line):
            if in_code:
                blocks.append("<pre><code>" + html.escape("\n".join(code_buf)) + "</code></pre>")
                code_buf = []
            in_code = not in_code
            continue
        if in_code:
            code_buf.append(raw_line)
            continue
        line = raw_line.strip()
        if not line:
            continue
        heading = re.match(r"^(#{1,6})\s+(.+)$", line)
        if heading:
            lvl = min(6, len(heading.group(1)) + 1)
            blocks.append(f"<h{lvl}>{html.escape(_plain_inline(heading.group(2)))}</h{lvl}>")
        elif re.match(r"^[-+*]\s+", line):
            bullet_text = _plain_inline(re.sub(r"^[-+*]\s+", "", line))
            blocks.append(f"<p>• {html.escape(bullet_text)}</p>")
        else:
            blocks.append(f"<p>{html.escape(_plain_inline(line))}</p>")
    if code_buf:
        blocks.append("<pre><code>" + html.escape("\n".join(code_buf)) + "</code></pre>")

    chapter_xhtml = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<!DOCTYPE html>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml" lang="en">\n'
        f"<head><meta charset=\"utf-8\"/><title>{title_esc}</title>"
        "<style>body{font-family:Georgia,serif;line-height:1.7;margin:1.5em;}pre{background:#f3f4f6;padding:1em;overflow-x:auto;font-family:monospace;}</style>"
        "</head>\n<body>\n" + "\n".join(blocks) + "\n</body>\n</html>\n"
    ).encode("utf-8")

    nav_xhtml = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<!DOCTYPE html>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">\n'
        f"<head><meta charset=\"utf-8\"/><title>{title_esc}</title></head>\n"
        f'<body><nav epub:type="toc"><h1>Contents</h1><ol><li><a href="chapter.xhtml">{title_esc}</a></li></ol></nav></body>\n'
        "</html>\n"
    ).encode("utf-8")

    content_opf = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">\n'
        '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
        f'    <dc:identifier id="pub-id">{book_id}</dc:identifier>\n'
        f"    <dc:title>{title_esc}</dc:title>\n"
        "    <dc:language>en</dc:language>\n"
        f'    <meta property="dcterms:modified">{modified}</meta>\n'
        "  </metadata>\n"
        "  <manifest>\n"
        '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n'
        '    <item id="chap1" href="chapter.xhtml" media-type="application/xhtml+xml"/>\n'
        "  </manifest>\n"
        '  <spine><itemref idref="chap1"/></spine>\n'
        "</package>\n"
    ).encode("utf-8")

    container_xml = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
        '  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n'
        "</container>\n"
    ).encode("utf-8")

    buf = io.BytesIO()
    with ZipFile(buf, "w", ZIP_DEFLATED) as archive:
        archive.writestr("mimetype", b"application/epub+zip", compress_type=ZIP_STORED)
        archive.writestr("META-INF/container.xml", container_xml)
        archive.writestr("OEBPS/content.opf", content_opf)
        archive.writestr("OEBPS/nav.xhtml", nav_xhtml)
        archive.writestr("OEBPS/chapter.xhtml", chapter_xhtml)
    return buf.getvalue()


def parse_bibtex_to_note(bibtex_text: Any) -> dict[str, Any]:
    """Parse a BibTeX entry into a structured Xotira academic literature note."""
    if not isinstance(bibtex_text, str) or not bibtex_text.strip():
        raise VaultError("Paste a valid BibTeX entry (for example, @article{key, title={...}}).")
    raw = bibtex_text.strip()
    header = re.match(r"@([a-zA-Z]+)\s*\{\s*([^,\s]+)\s*,", raw)
    if not header:
        raise VaultError("Could not parse BibTeX header. Expected @article{citekey, ...}.")
    entry_type = header.group(1).lower()
    cite_key = header.group(2).strip()

    fields: dict[str, str] = {}
    for match in re.finditer(r"([a-zA-Z0-9_-]+)\s*=\s*(?:\{((?:[^{}]|\{[^{}]*\})*)\}|\"([^\"]*)\"|(\d+))", raw):
        key = match.group(1).lower()
        val = next(g for g in match.groups()[1:] if g is not None)
        fields[key] = re.sub(r"\s+", " ", val.replace("{", "").replace("}", "")).strip()

    title = fields.get("title") or cite_key
    author = fields.get("author", "Unknown author")
    year = fields.get("year", "")
    venue = fields.get("journal") or fields.get("booktitle") or fields.get("publisher") or ""
    doi = fields.get("doi", "")
    url = fields.get("url") or (f"https://doi.org/{doi}" if doi else "")
    abstract = fields.get("abstract", "")

    clean_note_title = re.sub(r"[\[\]#|]", "", title)[:115].strip() or cite_key
    body_lines = [
        "---",
        f"type: paper",
        f"citekey: {cite_key}",
        f"entryType: {entry_type}",
        f"author: {author}",
        f"year: {year}" if year else "year: unknown",
        f"venue: {venue}" if venue else "venue: ''",
        f"doi: {doi}" if doi else "doi: ''",
        "---",
        "",
        f"# {clean_note_title}",
        "",
        f"- **Authors:** {author}",
        f"- **Year:** {year or '—'} · **Venue:** {venue or '—'}",
    ]
    if url:
        body_lines.append(f"- **Source:** [{url}]({url})")
    body_lines.extend([
        "",
        "## Abstract / Summary",
        abstract or "Add your concise summary here.",
        "",
        "## Key Findings & Claims",
        "- Claim 1 [^1]",
        "",
        "## Citation",
        "```bibtex",
        raw,
        "```",
        "",
        f"[^1]: {author} ({year or 'n.d.'}). {title}. {venue}".strip(),
    ])
    tags = ["Paper", "Research"]
    if year.isdigit():
        tags.append(year)
    return {
        "title": clean_note_title,
        "tags": tags,
        "body": "\n".join(body_lines),
        "useAvailableTitle": True,
    }
