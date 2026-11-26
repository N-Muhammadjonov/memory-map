"""AI Agent Brain API: GraphRAG context packing, ranked search, and unlinked mentions."""

from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from document_preview import preview_office
from vault import Note, Vault, title_key
from vault_links import LinkIndex

TOKEN_RE = re.compile(r"[\w'-]{2,}", re.UNICODE)
HEADING_RE = re.compile(r"^#{1,6}\s+(.+)$", re.MULTILINE)
TEXT_EXTS = {
    ".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".yaml", ".yml",
    ".toml", ".ini", ".py", ".js", ".ts", ".jsx", ".tsx", ".html", ".css",
    ".sql", ".sh", ".xml", ".log",
}
OFFICE_EXTS = {".docx", ".pptx", ".xlsx"}


def tokenize(text: str) -> list[str]:
    normal = title_key(text).translate(str.maketrans({"’": "'", "‘": "'", "ʻ": "'", "ʼ": "'"}))
    return TOKEN_RE.findall(normal)


def excerpt_for(text: str, terms: list[str], limit: int = 240) -> str:
    clean = re.sub(r"^---[\s\S]*?---\s*", "", text, count=1).strip()
    clean = re.sub(r"\s+", " ", clean)
    if not clean:
        return ""
    lower = clean.casefold()
    pos = -1
    for term in terms:
        idx = lower.find(term)
        if idx >= 0 and (pos < 0 or idx < pos):
            pos = idx
    if pos < 0:
        return clean[:limit] + ("…" if len(clean) > limit else "")
    start = max(0, pos - 60)
    end = min(len(clean), start + limit)
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(clean) else ""
    return prefix + clean[start:end] + suffix


def extract_note_preview(body: str, limit: int = 180) -> str:
    stripped = re.sub(r"^---[\s\S]*?---\s*", "", body, count=1)
    stripped = re.sub(r"```[\s\S]*?```", " ", stripped)
    stripped = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", stripped)
    stripped = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", stripped)
    stripped = re.sub(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]", lambda m: m.group(2) or m.group(1), stripped)
    stripped = re.sub(r"[#*_~`>]", "", stripped)
    stripped = re.sub(r"\s+", " ", stripped).strip()
    return stripped[:limit] + ("…" if len(stripped) > limit else "")


def build_graph_index(vault: Vault) -> tuple[list[Note], list[dict[str, Any]], LinkIndex, dict[str, set[str]], dict[str, set[str]]]:
    protected_ids = vault.protected_note_ids()
    if vault.ai_scoped:
        import settings
        protected_ids.update(settings.load(vault, "note_ai_visibility", []))
    active = [n for n in vault.notes.values() if not n.trashed and not n.storage_only and n.id not in protected_ids]
    files = [file for file in vault.list_attachments() if file["noteId"] not in protected_ids]
    index = LinkIndex(active, files, title_key)
    outgoing: dict[str, set[str]] = defaultdict(set)
    incoming: dict[str, set[str]] = defaultdict(set)
    relationships: dict[str, set[str]] = defaultdict(set)
    for relation in vault.relationships(active):
        relationships[relation["source"]].add(relation["target"])
    for note in active:
        targets = (set(index.links_for(note).values()) | index.attached[note.id] |
                   relationships[note.id]) - {note.id}
        outgoing[note.id] = targets
        for tgt in targets:
            incoming[tgt].add(note.id)
    return active, files, index, outgoing, incoming


def search_index(vault: Vault) -> tuple:
    cached = vault.search_cache
    if not vault.ai_scoped and cached and cached[0] == vault.changes:
        return cached[1]
    active, files, _, outgoing, incoming = build_graph_index(vault)
    postings: dict[str, dict[str, int]] = defaultdict(dict)
    lengths = {}
    headings = {}
    metadata = {}
    for note in active:
        fields = vault.entity(note.id)["fields"]
        terms = Counter(tokenize(" ".join((note.title, *note.aliases, *note.tags, note.source, note.path,
                                           *[value for value in fields.values() if isinstance(value, str)],
                                           note.body))))
        lengths[note.id] = sum(terms.values())
        headings[note.id] = set(tokenize(" ".join(HEADING_RE.findall(note.body))))
        metadata[note.id] = set(tokenize(f"{note.title} {' '.join(note.aliases)} {' '.join(note.tags)}"))
        for term, count in terms.items():
            postings[term][note.id] = count
    average = max(1.0, sum(lengths.values()) / max(1, len(active)))
    result = ({note.id: note for note in active}, files, outgoing, incoming, postings, lengths, headings, metadata, average)
    if not vault.ai_scoped:
        vault.search_cache = (vault.changes, result)
    return result


def search_brain(
    vault: Vault,
    query: str,
    *,
    tag: str = "",
    limit: int = 12,
    include_body: bool = False,
) -> dict[str, Any]:
    vault.require_unlocked()
    notes_by_id, files, outgoing, incoming, postings, lengths, headings, metadata, average = search_index(vault)
    terms = list(dict.fromkeys(tokenize(query)))
    tag_key = title_key(tag)
    document_count = len(notes_by_id)
    q_norm = title_key(query)
    if terms:
        ids = set().union(*(postings.get(term, {}) for term in terms))
    elif q_norm:
        ids = {note.id for note in notes_by_id.values() if q_norm in title_key(note.title + " " + note.body)}
    else:
        ids = set(notes_by_id)
    scored: list[tuple[float, Note]] = []
    for note_id in ids:
        note = notes_by_id[note_id]
        if tag_key and all(title_key(entry) != tag_key for entry in note.tags):
            continue
        title = title_key(note.title)
        score = 40.0 if q_norm and q_norm == title else 12.0 if q_norm and q_norm in title else 0.0
        length_factor = 1.2 * (0.25 + 0.75 * lengths[note_id] / average)
        matches = 0
        for term in terms:
            docs = postings.get(term, {})
            tf = docs.get(note_id, 0)
            if not tf:
                continue
            matches += 1
            idf = math.log1p((document_count - len(docs) + 0.5) / (len(docs) + 0.5))
            score += idf * tf * 2.2 / (tf + length_factor)
            score += 4.0 * (term in metadata[note_id]) + 2.0 * (term in headings[note_id])
        if matches == len(terms) and matches > 1:
            score *= 1.35
        degree = len(outgoing[note_id]) + len(incoming[note_id])
        score += min(1.0, math.sqrt(degree) * 0.15)
        scored.append((score, note))
    scored.sort(key=lambda pair: (pair[0], pair[1].updated, pair[1].id), reverse=True)
    clamped = max(1, min(limit, 50))
    results = []
    for score, note in scored[:clamped]:
        item: dict[str, Any] = {
            "id": note.id,
            "title": note.title,
            "tags": note.tags,
            "path": f"{note.source}/{note.path}" if note.path else note.title,
            "updated": note.updated,
            "score": round(score, 3),
            "snippet": excerpt_for(note.body, terms),
            "source": {"noteId": note.id, "revision": note.revision, "uri": f"xotira:{note.id}"},
            "backlinks": [notes_by_id[nid].title for nid in sorted(incoming[note.id]) if nid in notes_by_id],
            "outgoing": [notes_by_id[nid].title for nid in sorted(outgoing[note.id]) if nid in notes_by_id],
        }
        if include_body:
            item["body"] = note.body
        results.append(item)

    file_hits: list[dict[str, Any]] = []
    if terms and not tag_key:
        for file in files:
            name_low = f"{file['name']} {file.get('path', '')} {file.get('noteTitle', '')}".casefold()
            matched_content = False
            snippet = ""
            if not any(term in name_low for term in terms):
                suffix = Path(file["name"]).suffix.lower()
                if suffix in TEXT_EXTS or suffix in OFFICE_EXTS or suffix == ".pdf":
                    try:
                        extracted = extract_attachment_text(vault, file["noteId"], file["id"], max_chars=12000)
                    except Exception:
                        extracted = ""
                    if extracted:
                        ext_low = extracted.casefold()
                        if any(term in ext_low for term in terms):
                            matched_content = True
                            snippet = excerpt_for(extracted, terms, limit=180)
            if any(term in name_low for term in terms) or matched_content:
                file_hits.append({
                    "id": file["id"],
                    "noteId": file["noteId"],
                    "name": file["name"],
                    "path": snippet or file.get("path", ""),
                })
                if len(file_hits) >= 10:
                    break

    return {"query": query, "count": len(results), "results": results, "files": file_hits}


def _char_ngrams(text: str, n: int = 3) -> Counter[str]:
    cleaned = re.sub(r"\s+", " ", title_key(text)).strip()
    if len(cleaned) < n:
        return Counter([cleaned] if cleaned else [])
    return Counter(cleaned[i:i + n] for i in range(len(cleaned) - n + 1))


def semantic_search_brain(
    vault: Vault,
    query: str,
    *,
    tag: str = "",
    limit: int = 12,
) -> dict[str, Any]:
    """100% local TF-IDF + character 3-gram cosine similarity search (zero cloud calls)."""
    vault.require_unlocked()
    base = search_brain(vault, query, tag=tag, limit=limit)
    notes_by_id, _, outgoing, incoming, _, _, _, _, _ = search_index(vault)
    q_grams = _char_ngrams(query)
    if not q_grams:
        return {**base, "mode": "semantic"}
    q_norm = math.sqrt(sum(v * v for v in q_grams.values())) or 1.0
    tag_key = title_key(tag)
    existing_scores = {item["id"]: item["score"] for item in base["results"]}
    scored: list[tuple[float, Note]] = []
    for note in notes_by_id.values():
        if tag_key and all(title_key(entry) != tag_key for entry in note.tags):
            continue
        doc_text = f"{note.title} {' '.join(note.tags)} {note.body[:4000]}"
        d_grams = _char_ngrams(doc_text)
        d_norm = math.sqrt(sum(v * v for v in d_grams.values())) or 1.0
        dot = sum(q_grams[g] * d_grams[g] for g in q_grams if g in d_grams)
        cosine = dot / (q_norm * d_norm)
        combined = existing_scores.get(note.id, 0.0) + cosine * 25.0
        if combined >= 1.5:
            scored.append((combined, note))
    scored.sort(key=lambda pair: (pair[0], pair[1].updated), reverse=True)
    terms = list(dict.fromkeys(tokenize(query)))
    results = []
    for score, note in scored[:max(1, min(limit, 50))]:
        results.append({
            "id": note.id,
            "title": note.title,
            "tags": note.tags,
            "path": f"{note.source}/{note.path}" if note.path else note.title,
            "updated": note.updated,
            "score": round(score, 3),
            "snippet": excerpt_for(note.body, terms),
            "source": {"noteId": note.id, "revision": note.revision, "uri": f"xotira:{note.id}"},
            "backlinks": [notes_by_id[nid].title for nid in sorted(incoming[note.id]) if nid in notes_by_id],
            "outgoing": [notes_by_id[nid].title for nid in sorted(outgoing[note.id]) if nid in notes_by_id],
        })
    return {"query": query, "mode": "semantic", "count": len(results), "results": results, "files": base["files"]}


def _extract_pdf_text(content: bytes, max_chars: int) -> str:
    """Extract readable text strings from uncompressed PDF text operators without external deps."""
    chunks: list[str] = []
    total = 0
    for match in re.finditer(rb"\(([^()\\]{3,200})\)\s*Tj", content):
        piece = match.group(1).decode("latin-1", errors="ignore").strip()
        if piece:
            chunks.append(piece)
            total += len(piece) + 1
            if total >= max_chars:
                break
    return " ".join(chunks)[:max_chars]


def extract_attachment_text(vault: Vault, note_id: str, attachment_id: str, max_chars: int = 8000) -> str:
    name, content = vault.attachment(note_id, attachment_id)
    suffix = Path(name).suffix.lower()
    if suffix in TEXT_EXTS:
        return content.decode("utf-8", errors="replace")[:max_chars]
    if suffix in OFFICE_EXTS:
        preview = preview_office(name, content)
        parts: list[str] = []
        for section in preview.get("sections", []):
            if section.get("heading"):
                parts.append(f"## {section['heading']}")
            for para in section.get("paragraphs", []):
                parts.append(para)
            for row in section.get("rows", []):
                parts.append(" | ".join(str(cell) for cell in row))
        return "\n".join(parts)[:max_chars]
    if suffix == ".pdf":
        return _extract_pdf_text(content, max_chars)
    return ""


def build_context_pack(
    vault: Vault,
    query: str,
    *,
    max_chars: int = 12000,
    limit: int = 6,
    hops: int = 1,
) -> dict[str, Any]:
    vault.require_unlocked()
    max_chars = max(1000, min(max_chars, 80_000))
    search_res = search_brain(vault, query, limit=limit, include_body=True)
    notes_by_id, _, outgoing, incoming, *_ = search_index(vault)
    selected_ids: list[str] = [item["id"] for item in search_res["results"]]
    seen = set(selected_ids)
    neighbor_ids: list[str] = []
    frontier = selected_ids
    for _ in range(max(0, min(hops, 3))):
        layer = []
        for nid in frontier:
            for linked in sorted(outgoing[nid] | incoming[nid]):
                if linked in notes_by_id and linked not in seen:
                    seen.add(linked)
                    layer.append(linked)
        neighbor_ids.extend(layer)
        frontier = layer
        if not frontier:
            break

    label = query[:400].replace("\n", " ")
    blocks: list[str] = [f"# Xotira Brain Context for: {label}\n"]
    used = len(blocks[0])
    included_notes: list[dict[str, Any]] = []

    def add_note(note: Note, role: str) -> None:
        nonlocal used
        if used >= max_chars:
            return
        header = (
            f"\n## [{role}] {note.title}\n"
            f"- Path: {note.source + '/' + note.path if note.path else note.title}\n"
            f"- Tags: {', '.join(note.tags) if note.tags else 'none'}\n"
            f"- Updated: {note.updated}\n\n"
        )
        remaining = max_chars - used - len(header) - 1
        if remaining < 120:
            return
        suffix = "\n…[truncated]" if len(note.body) > remaining else ""
        end_offset = min(len(note.body), remaining - len(suffix))
        snippet = note.body[:end_offset]
        block = header + snippet + suffix + "\n"
        blocks.append(block)
        used += len(block)
        included_notes.append({
            "id": note.id,
            "title": note.title,
            "role": role,
            "source": {"noteId": note.id, "revision": note.revision, "uri": f"xotira:{note.id}",
                       "startOffset": 0, "endOffset": end_offset},
            "tags": note.tags,
            "path": f"{note.source}/{note.path}" if note.path else note.title,
        })

    for nid in selected_ids:
        if nid in notes_by_id:
            add_note(notes_by_id[nid], "PRIMARY")
    for nid in neighbor_ids[:limit]:
        if nid in notes_by_id:
            add_note(notes_by_id[nid], "LINKED_NEIGHBOR")

    return {
        "query": query,
        "context": "".join(blocks).strip(),
        "chars": used,
        "notes": included_notes,
    }


def brain_stats(vault: Vault) -> dict[str, Any]:
    vault.require_unlocked()
    active, files, _, outgoing, incoming = build_graph_index(vault)
    tag_counts: Counter[str] = Counter()
    folder_counts: Counter[str] = Counter()
    hubs: list[dict[str, Any]] = []
    total_edges = 0
    for note in active:
        for tag in note.tags:
            tag_counts[tag] += 1
        folder = note.source or (note.path.split("/")[0] if "/" in note.path else "Root")
        folder_counts[folder] += 1
        deg = len(outgoing[note.id]) + len(incoming[note.id])
        total_edges += len(outgoing[note.id])
        hubs.append({"id": note.id, "title": note.title, "degree": deg, "tags": note.tags})
    hubs.sort(key=lambda item: (-item["degree"], item["title"]))
    recent = [
        {"id": n.id, "title": n.title, "updated": n.updated, "tags": n.tags}
        for n in sorted(active, key=lambda n: n.updated, reverse=True)[:10]
    ]
    return {
        "notes": len(active),
        "files": len(files),
        "links": total_edges,
        "tags": dict(tag_counts.most_common(30)),
        "clusters": dict(folder_counts.most_common(30)),
        "topHubs": hubs[:12],
        "recent": recent,
    }


def export_brain_json(vault: Vault) -> dict[str, Any]:
    vault.require_unlocked()
    active, files, _, outgoing, _ = build_graph_index(vault)
    nodes = [
        {
            "id": n.id,
            "title": n.title,
            "tags": n.tags,
            "aliases": n.aliases,
            "path": n.path,
            "source": n.source,
            "updated": n.updated,
            "body": n.body,
            "revision": n.revision,
            "entity": vault.entity(n.id),
        }
        for n in active
    ]
    edges = [
        {"source": nid, "target": tgt}
        for nid, targets in outgoing.items()
        for tgt in sorted(targets)
    ]
    return {
        "schema": "xotira-brain/1.0",
        "stats": brain_stats(vault),
        "nodes": nodes,
        "files": files,
        "edges": edges,
        "relationships": vault.relationships(active),
    }


def find_unlinked_mentions(vault: Vault, note_id: str) -> list[dict[str, Any]]:
    vault.require_unlocked()
    target = vault.notes.get(note_id)
    if target is None or target.trashed or target.storage_only:
        return []
    terms = [name for name in [target.title, *target.aliases] if len(name.strip()) >= 3]
    if not terms:
        return []
    active, _, _, outgoing, _ = build_graph_index(vault)
    patterns = [re.compile(r"(?<!\[)\b" + re.escape(term) + r"\b(?!\])", re.IGNORECASE) for term in terms]
    mentions: list[dict[str, Any]] = []
    for other in active:
        if other.id == note_id or note_id in outgoing[other.id]:
            continue
        for term, pattern in zip(terms, patterns):
            match = pattern.search(other.body)
            if match:
                start = max(0, match.start() - 45)
                end = min(len(other.body), match.end() + 65)
                snippet = re.sub(r"\s+", " ", other.body[start:end]).strip()
                mentions.append({
                    "id": other.id,
                    "title": other.title,
                    "matched": match.group(0),
                    "snippet": ("…" if start > 0 else "") + snippet + ("…" if end < len(other.body) else ""),
                })
                break
        if len(mentions) >= 25:
            break
    return mentions
