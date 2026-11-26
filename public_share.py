"""Isolated single-note public publishing with NotionNext-inspired themes and ArticleLock."""

from __future__ import annotations

import base64
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from typing import Any

from vault import Vault, VaultError, title_key
from vault_links import WIKILINK

PUBLIC_SHARES_SCHEMA = """CREATE TABLE IF NOT EXISTS public_shares (
    slug TEXT PRIMARY KEY,
    note_id TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    tags TEXT NOT NULL,
    body_md TEXT NOT NULL,
    theme TEXT NOT NULL DEFAULT 'gitbook',
    password_hash TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    published_at TEXT NOT NULL
)"""

PUBLIC_THEMES = {"gitbook", "minimal", "paper"}
SLUG_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{2,78}[a-z0-9]$")
MAX_PUBLIC_IMAGE_BYTES = 2 * 1024 * 1024
IMAGE_MIME = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
}


def ensure_public_schema(database: sqlite3.Connection) -> None:
    database.execute(PUBLIC_SHARES_SCHEMA)


def _slugify(title: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:48] or "note"
    return f"{base}-{secrets.token_hex(4)}"


def _hash_share_password(password: str) -> str:
    salt = os.urandom(16)
    derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${derived.hex()}"


def verify_share_password(stored_hash: str, candidate: str) -> bool:
    if not stored_hash:
        return True
    parts = stored_hash.split("$")
    if len(parts) != 3 or parts[0] != "scrypt":
        return False
    try:
        salt = bytes.fromhex(parts[1])
        expected = bytes.fromhex(parts[2])
    except ValueError:
        return False
    actual = hashlib.scrypt(candidate.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=32)
    return hmac.compare_digest(expected, actual)


def make_unlock_cookie(secret_key: str, slug: str, password_hash: str) -> str:
    payload = f"{slug}:{password_hash}".encode("utf-8")
    return hmac.new(secret_key.encode("utf-8"), payload, hashlib.sha256).hexdigest()


def verify_unlock_cookie(secret_key: str, slug: str, password_hash: str, token: str) -> bool:
    if not token:
        return False
    expected = make_unlock_cookie(secret_key, slug, password_hash)
    return hmac.compare_digest(expected, token)


def _strip_frontmatter(markdown: str) -> str:
    return re.sub(r"^---\r?\n[\s\S]*?\r?\n---\r?\n*", "", markdown, count=1)


def _summarize(markdown: str) -> str:
    clean = _strip_frontmatter(markdown)
    clean = re.sub(r"```[\s\S]*?```", " ", clean)
    clean = re.sub(r"[#*_~`>\[\]()!|]", " ", clean)
    clean = re.sub(r"\s+", " ", clean).strip()
    return clean[:180] + ("…" if len(clean) > 180 else "")


def _sanitize_public_markdown(vault: Vault, note_id: str, raw_body: str, public_by_title: dict[str, str]) -> str:
    """Remove private internal note IDs/links and embed only safe images from this note."""
    body = _strip_frontmatter(raw_body)

    def replace_wiki(match: re.Match[str]) -> str:
        target = match.group(1).strip()
        alias = match.group(3).strip() if match.lastindex and match.lastindex >= 3 and match.group(3) else ""
        label = alias or target
        public_slug = public_by_title.get(title_key(target))
        if public_slug:
            return f"[{label}](/p/{public_slug})"
        return label

    body = WIKILINK.sub(replace_wiki, body)

    # Strip internal xotira:<id> links so private note IDs never leak
    body = re.sub(r"\[([^\]]+)\]\(xotira:[0-9a-f]{32}\)", r"\1", body)

    # Embed image attachments belonging to THIS note as data URIs; strip non-image attachment links
    def replace_attachment_image(match: re.Match[str]) -> str:
        alt = match.group(1) or "Image"
        attachment_id = match.group(2)
        try:
            name, content = vault.attachment(note_id, attachment_id)
        except VaultError:
            return ""
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        mime = IMAGE_MIME.get(ext)
        if not mime or len(content) > MAX_PUBLIC_IMAGE_BYTES:
            return ""
        encoded = base64.b64encode(content).decode("ascii")
        return f"![{alt}](data:{mime};base64,{encoded})"

    body = re.sub(r"!\[([^\]]*)\]\(attachment:([0-9a-f]{32})\)", replace_attachment_image, body)
    body = re.sub(r'\[([^\]]+)\]\(attachment:[0-9a-f]{32}(?: "Mind map")?\)', r"\1", body)
    return body


def get_note_share_status(vault: Vault, note_id: str) -> dict[str, Any]:
    vault.require_unlocked()
    note = vault.notes.get(note_id)
    if note is None or note.storage_only:
        raise VaultError("Note not found.", 404)
    with vault.connection() as database:
        ensure_public_schema(database)
        row = database.execute(
            "SELECT slug, theme, password_hash, updated_at, published_at FROM public_shares WHERE note_id = ?",
            (note_id,),
        ).fetchone()
    if not row:
        return {"enabled": False, "slug": "", "theme": "gitbook", "hasPassword": False, "publishedAt": "", "updatedAt": ""}
    return {
        "enabled": True,
        "slug": row[0],
        "theme": row[1],
        "hasPassword": bool(row[2]),
        "updatedAt": row[3],
        "publishedAt": row[4],
    }


def list_public_shares(vault: Vault) -> list[dict[str, Any]]:
    vault.require_unlocked()
    with vault.connection() as database:
        ensure_public_schema(database)
        rows = database.execute(
            "SELECT slug, note_id, title, theme, password_hash, published_at, updated_at FROM public_shares ORDER BY published_at DESC"
        ).fetchall()
    return [
        {
            "slug": row[0],
            "noteId": row[1],
            "title": row[2],
            "theme": row[3],
            "hasPassword": bool(row[4]),
            "publishedAt": row[5],
            "updatedAt": row[6],
        }
        for row in rows
    ]


def configure_note_share(vault: Vault, note_id: str, config: dict[str, Any]) -> dict[str, Any]:
    """Publish, update, or unpublish a single isolated note."""
    vault.require_unlocked()
    note = vault.notes.get(note_id)
    if note is None or note.storage_only or note.trashed:
        raise VaultError("Active note not found.", 404)

    enabled = bool(config.get("enabled", True))
    with vault.connection() as database, database:
        ensure_public_schema(database)
        existing = database.execute(
            "SELECT slug, password_hash, published_at FROM public_shares WHERE note_id = ?",
            (note_id,),
        ).fetchone()

        if not enabled:
            database.execute("DELETE FROM public_shares WHERE note_id = ?", (note_id,))
            return {"enabled": False, "slug": "", "theme": "gitbook", "hasPassword": False, "publishedAt": "", "updatedAt": ""}

        theme = str(config.get("theme", "gitbook")).strip().lower()
        if theme not in PUBLIC_THEMES:
            theme = "gitbook"

        requested_slug = str(config.get("slug", "")).strip().lower()
        if requested_slug:
            if not SLUG_PATTERN.fullmatch(requested_slug):
                raise VaultError("Slug must be 4–80 lowercase letters, numbers, or hyphens.")
            conflict = database.execute(
                "SELECT note_id FROM public_shares WHERE slug = ? AND note_id != ?",
                (requested_slug, note_id),
            ).fetchone()
            if conflict:
                raise VaultError("That public link slug is already used by another note.", 409)
            slug = requested_slug
        elif existing:
            slug = existing[0]
        else:
            slug = _slugify(note.title)

        # Password handling: keep existing if password omitted; clear if empty string explicitly passed
        if "password" in config:
            raw_pw = config.get("password")
            if raw_pw is None or raw_pw == "":
                password_hash = ""
            elif isinstance(raw_pw, str) and 4 <= len(raw_pw) <= 128:
                password_hash = _hash_share_password(raw_pw)
            else:
                raise VaultError("Public page password must be 4–128 characters.")
        else:
            password_hash = existing[1] if existing else ""

        # Map only ALREADY-PUBLIC notes so private note titles/IDs never leak
        public_rows = database.execute("SELECT title, slug FROM public_shares WHERE note_id != ?", (note_id,)).fetchall()
        public_by_title = {title_key(r[0]): r[1] for r in public_rows}

        sanitized_md = _sanitize_public_markdown(vault, note_id, note.body, public_by_title)
        summary = _summarize(sanitized_md)
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        published_at = existing[2] if existing else now

        if existing:
            database.execute(
                """UPDATE public_shares
                   SET slug = ?, title = ?, summary = ?, tags = ?, body_md = ?, theme = ?, password_hash = ?, updated_at = ?
                   WHERE note_id = ?""",
                (slug, note.title, summary, json.dumps(note.tags, ensure_ascii=False), sanitized_md, theme, password_hash, now, note_id),
            )
        else:
            database.execute(
                """INSERT INTO public_shares
                   (slug, note_id, title, summary, tags, body_md, theme, password_hash, updated_at, published_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (slug, note_id, note.title, summary, json.dumps(note.tags, ensure_ascii=False), sanitized_md, theme, password_hash, now, published_at),
            )

    return {
        "enabled": True,
        "slug": slug,
        "theme": theme,
        "hasPassword": bool(password_hash),
        "publishedAt": published_at,
        "updatedAt": now,
    }


def fetch_public_snapshot(vault: Vault, slug: str) -> dict[str, Any] | None:
    """Read ONLY the isolated public_shares table — never touches encrypted vault notes."""
    if not vault.exists or not SLUG_PATTERN.fullmatch(slug):
        return None
    try:
        with closing(sqlite3.connect(f"{vault.path.as_uri()}?mode=ro", uri=True, timeout=2)) as database:
            row = database.execute(
                "SELECT slug, title, summary, tags, body_md, theme, password_hash, updated_at, published_at FROM public_shares WHERE slug = ?",
                (slug,),
            ).fetchone()
    except sqlite3.Error:
        return None
    if not row:
        return None
    return {
        "slug": row[0],
        "title": row[1],
        "summary": row[2],
        "tags": json.loads(row[3]) if row[3] else [],
        "body_md": row[4],
        "theme": row[5] if row[5] in PUBLIC_THEMES else "gitbook",
        "password_hash": row[6] or "",
        "updated_at": row[7],
        "published_at": row[8],
    }


def _render_inline_safe(text: str) -> str:
    escaped = html.escape(text, quote=True)
    slots: list[str] = []

    def stash(fragment: str) -> str:
        slots.append(fragment)
        return f"\x00P{len(slots) - 1}\x00"

    escaped = re.sub(r"`([^`\n]+)`", lambda m: stash(f"<code>{m.group(1)}</code>"), escaped)

    def render_img(match: re.Match[str]) -> str:
        alt, src = match.group(1), match.group(2)
        if re.match(r"^data:image/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$", src):
            return stash(f'<img class="pub-img" src="{src}" alt="{alt}" loading="lazy">')
        return alt

    escaped = re.sub(r"!\[([^\]]*)\]\(([^)\s]+)\)", render_img, escaped)

    def render_link(match: re.Match[str]) -> str:
        label, href = match.group(1), match.group(2)
        if re.match(r"^(?:https?://|/p/[a-z0-9-]+$)", href, re.I):
            rel = ' target="_blank" rel="noopener noreferrer"' if href.lower().startswith("http") else ""
            return stash(f'<a href="{href}"{rel}>{label}</a>')
        return label

    escaped = re.sub(r"\[([^\]\n]+)\]\(([^)\s]+)\)", render_link, escaped)
    escaped = re.sub(r"\*\*\*([^*\n]+)\*\*\*", r"<strong><em>\1</em></strong>", escaped)
    escaped = re.sub(r"\*\*([^*\n]+)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"\*([^*\n]+)\*", r"<em>\1</em>", escaped)
    escaped = re.sub(r"~~([^~\n]+)~~", r"<s>\1</s>", escaped)
    escaped = re.sub(r"==([^=\n]+)==", r"<mark>\1</mark>", escaped)

    return re.sub(r"\x00P(\d+)\x00", lambda m: slots[int(m.group(1))], escaped)


def _render_markdown_safe(markdown: str) -> tuple[str, list[dict[str, Any]], int]:
    """Render sanitized Markdown to HTML + TOC list + word count."""
    lines = markdown.replace("\r\n", "\n").split("\n")
    out: list[str] = []
    toc: list[dict[str, Any]] = []
    words = len(re.findall(r"\S+", markdown))
    i = 0

    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue

        fence = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line)
        if fence:
            marker = fence.group(1)
            lang = html.escape(fence.group(2).strip().split(" ")[0][:24] or "text")
            buf: list[str] = []
            i += 1
            end_rx = re.compile(rf"^ {{0,3}}{re.escape(marker[0])}{{{len(marker)},}}\s*$")
            while i < len(lines) and not end_rx.match(lines[i]):
                buf.append(lines[i])
                i += 1
            if i < len(lines):
                i += 1
            code_text = "\n".join(buf)
            line_count = len(buf)
            numbered = "\n".join(
                f'<span class="pub-ln">{idx}</span>{html.escape(row)}'
                for idx, row in enumerate(buf, 1)
            )
            collapsible = line_count >= 20
            open_attr = "" if collapsible else " open"
            out.append(
                f'<details class="pub-code"{open_attr}>'
                f'<summary><span class="pub-code-lang">{lang.upper()} · {line_count} lines</span>'
                f'<span class="pub-code-hint">{"Expand / Collapse" if collapsible else "Code"}</span></summary>'
                f'<pre><code>{numbered}</code></pre></details>'
            )
            continue

        h_match = re.match(r"^ {0,3}(#{1,6})[ \t]+(.+?)\s*$", line)
        if h_match:
            level = len(h_match.group(1))
            text = h_match.group(2).rstrip("#").strip()
            hid = f"sec-{len(toc) + 1}"
            toc.append({"id": hid, "level": level, "text": text})
            out.append(f'<h{level} id="{hid}" class="pub-h">{_render_inline_safe(text)}</h{level}>')
            i += 1
            continue

        if re.match(r"^ {0,3}(?:---+|\*\*\*+|___+)\s*$", line):
            out.append("<hr>")
            i += 1
            continue

        if re.match(r"^ {0,3}>", line):
            q_lines: list[str] = []
            while i < len(lines) and re.match(r"^ {0,3}>", lines[i]):
                q_lines.append(re.sub(r"^ {0,3}>\s?", "", lines[i]))
                i += 1
            out.append("<blockquote>" + "<br>".join(_render_inline_safe(q) for q in q_lines) + "</blockquote>")
            continue

        if re.match(r"^\s*[-+*]\s+\[([ xX])\]\s+", line):
            items: list[str] = []
            while i < len(lines) and (m := re.match(r"^\s*[-+*]\s+\[([ xX])\]\s+(.*)$", lines[i])):
                checked = " checked" if m.group(1) != " " else ""
                items.append(f'<li class="pub-todo"><input type="checkbox" disabled{checked}><span>{_render_inline_safe(m.group(2))}</span></li>')
                i += 1
            out.append('<ul class="pub-todo-list">' + "".join(items) + "</ul>")
            continue

        if re.match(r"^\s*[-+*]\s+", line):
            items = []
            while i < len(lines) and re.match(r"^\s*[-+*]\s+", lines[i]) and not re.match(r"^\s*[-+*]\s+\[[ xX]\]\s+", lines[i]):
                item_text = re.sub(r"^\s*[-+*]\s+", "", lines[i])
                items.append(f"<li>{_render_inline_safe(item_text)}</li>")
                i += 1
            out.append("<ul>" + "".join(items) + "</ul>")
            continue

        if re.match(r"^\s*\d+[.)]\s+", line):
            items = []
            while i < len(lines) and re.match(r"^\s*\d+[.)]\s+", lines[i]):
                item_text = re.sub(r"^\s*\d+[.)]\s+", "", lines[i])
                items.append(f"<li>{_render_inline_safe(item_text)}</li>")
                i += 1
            out.append("<ol>" + "".join(items) + "</ol>")
            continue

        p_lines = [line]
        i += 1
        while (
            i < len(lines)
            and lines[i].strip()
            and not re.match(r"^(?:`{3,}|~{3,}| {0,3}#{1,6}\s|>|---+|\*\*\*+|___+|\s*[-+*]\s+|\s*\d+[.)]\s+)", lines[i])
        ):
            p_lines.append(lines[i])
            i += 1
        out.append("<p>" + "<br>".join(_render_inline_safe(p) for p in p_lines) + "</p>")

    return "\n".join(out), toc, words


def render_public_page_html(snapshot: dict[str, Any], *, locked: bool = False, error_msg: str = "") -> bytes:
    """Render a standalone, zero-leakage HTML page for a single public note."""
    title = html.escape(snapshot["title"])
    summary = "This shared note is protected with a password." if locked else html.escape(snapshot["summary"] or snapshot["title"])
    slug = html.escape(snapshot["slug"])
    theme = snapshot["theme"]
    tags_html = "".join(f'<span class="pub-tag">#{html.escape(t)}</span>' for t in snapshot.get("tags", []))

    if locked:
        err_html = f'<p class="pub-err" role="alert">{html.escape(error_msg)}</p>' if error_msg else ""
        content_html = f"""
        <section class="pub-lock">
          <h1>{title}</h1>
          <p class="pub-sub">This shared note is protected with a password.</p>
          <form method="POST" action="/p/{slug}/unlock" class="pub-lock-form">
            <input type="password" name="password" placeholder="Enter password…" required autocomplete="current-password">
            <button type="submit">Unlock note</button>
          </form>
          {err_html}
        </section>"""
        toc_html = ""
        stats_html = ""
        stale_html = ""
    else:
        body_html, toc, words = _render_markdown_safe(snapshot["body_md"])
        read_mins = max(1, (words + 199) // 200)
        stats_html = f'<div class="pub-meta"><span>{words} words · ~{read_mins} min read</span><span>Updated {html.escape(snapshot["updated_at"][:10])}</span></div>'

        stale_html = ""
        try:
            updated_dt = datetime.fromisoformat(snapshot["updated_at"].replace("Z", "+00:00"))
            days_old = (datetime.now(timezone.utc) - updated_dt).days
            if days_old >= 90:
                stale_html = f'<div class="pub-stale">Note last updated {days_old} days ago — some details may have changed.</div>'
        except ValueError:
            pass

        if toc and theme == "gitbook":
            toc_items = "".join(
                f'<a class="pub-toc-l{min(item["level"], 4)}" href="#{item["id"]}">{html.escape(item["text"])}</a>'
                for item in toc
            )
            toc_html = f'<aside class="pub-toc"><div class="pub-toc-title">On this page</div><nav>{toc_items}</nav></aside>'
        else:
            toc_html = ""

        content_html = f"""
        <article class="pub-article">
          <header class="pub-head">
            <div class="pub-badge">Shared via Memory map · Single Public Note</div>
            <h1>{title}</h1>
            {stats_html}
            <div class="pub-tags">{tags_html}</div>
          </header>
          {stale_html}
          <div class="pub-body">{body_html}</div>
        </article>"""

    page = f"""<!doctype html>
<html lang="en" data-pub-theme="{html.escape(theme)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <meta property="og:type" content="article">
  <meta property="og:title" content="{title}">
  <meta property="og:description" content="{summary}">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="{title}">
  <meta name="twitter:description" content="{summary}">
  <title>{title} — Memory map</title>
  <style>
    :root {{ --bg:#14161b; --surface:#1c1f26; --border:#2b303c; --text:#e6e8ee; --muted:#9aa3b2; --accent:#a78bfa; --code:#0f1116; }}
    :root[data-pub-theme="paper"] {{ --bg:#faf8f4; --surface:#f1eee7; --border:#ded9ce; --text:#1c1917; --muted:#57534e; --accent:#6d28d9; --code:#1e1e24; }}
    * {{ box-sizing:border-box; }}
    body {{ margin:0; background:var(--bg); color:var(--text); font:16px/1.72 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif; }}
    .pub-shell {{ max-width:1100px; margin:0 auto; padding:40px 24px 80px; display:grid; grid-template-columns:minmax(0,1fr); gap:36px; }}
    :root[data-pub-theme="gitbook"] .pub-shell:has(.pub-toc) {{ grid-template-columns:minmax(0,740px) 240px; justify-content:center; }}
    .pub-article {{ max-width:740px; width:100%; margin:0 auto; }}
    .pub-badge {{ font-size:12px; color:var(--accent); letter-spacing:.03em; text-transform:uppercase; margin-bottom:10px; }}
    .pub-head h1 {{ margin:0 0 10px; font-size:2.1rem; line-height:1.2; letter-spacing:-.025em; }}
    .pub-meta {{ display:flex; flex-wrap:wrap; gap:14px; font-size:13px; color:var(--muted); margin-bottom:10px; }}
    .pub-tags {{ display:flex; flex-wrap:wrap; gap:6px; margin-bottom:20px; }}
    .pub-tag {{ font-size:12px; padding:2px 8px; border-radius:99px; background:var(--surface); border:1px solid var(--border); color:var(--muted); }}
    .pub-stale {{ padding:10px 14px; border-radius:8px; border:1px solid var(--accent); background:var(--surface); font-size:13px; color:var(--muted); margin-bottom:20px; }}
    .pub-body h1,.pub-body h2,.pub-body h3 {{ margin:28px 0 10px; line-height:1.3; }}
    .pub-body a {{ color:var(--accent); text-underline-offset:3px; }}
    .pub-body blockquote {{ margin:14px 0; padding:6px 16px; border-left:3px solid var(--accent); color:var(--muted); background:var(--surface); border-radius:0 6px 6px 0; }}
    .pub-body code {{ font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.88em; background:var(--surface); padding:2px 5px; border-radius:4px; }}
    .pub-code {{ margin:16px 0; border:1px solid var(--border); border-radius:10px; background:var(--code); color:#e2e8f0; overflow:hidden; }}
    .pub-code summary {{ display:flex; justify-content:space-between; padding:8px 14px; cursor:pointer; font-size:12px; color:#94a3b8; background:rgba(255,255,255,.03); list-style:none; }}
    .pub-code pre {{ margin:0; padding:14px 16px; overflow-x:auto; font:13.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; }}
    .pub-code pre code {{ background:transparent; padding:0; color:inherit; }}
    .pub-ln {{ display:inline-block; width:34px; color:#64748b; user-select:none; }}
    .pub-img {{ max-width:100%; border-radius:8px; display:block; margin:14px 0; }}
    .pub-todo-list {{ list-style:none; padding-left:0; }}
    .pub-todo {{ display:flex; align-items:center; gap:8px; margin:6px 0; }}
    .pub-toc {{ position:sticky; top:32px; align-self:start; border-left:1px solid var(--border); padding-left:16px; }}
    .pub-toc-title {{ font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin-bottom:10px; }}
    .pub-toc nav {{ display:flex; flex-direction:column; gap:6px; }}
    .pub-toc a {{ color:var(--muted); text-decoration:none; font-size:13px; line-height:1.4; }}
    .pub-toc a:hover {{ color:var(--accent); }}
    .pub-toc-l2 {{ padding-left:10px; }} .pub-toc-l3 {{ padding-left:20px; }} .pub-toc-l4 {{ padding-left:28px; }}
    .pub-lock {{ max-width:420px; margin:80px auto; padding:28px; border:1px solid var(--border); border-radius:12px; background:var(--surface); text-align:center; }}
    .pub-lock-form {{ display:flex; gap:8px; margin-top:16px; }}
    .pub-lock-form input {{ flex:1; padding:8px 12px; border-radius:7px; border:1px solid var(--border); background:var(--bg); color:var(--text); }}
    .pub-lock-form button {{ padding:8px 16px; border-radius:7px; border:0; background:var(--accent); color:#fff; font-weight:600; cursor:pointer; }}
    .pub-err {{ color:#ef4444; font-size:13px; margin-top:10px; }}
    @media (max-width:900px) {{ :root[data-pub-theme="gitbook"] .pub-shell:has(.pub-toc) {{ grid-template-columns:minmax(0,1fr); }} .pub-toc {{ display:none; }} }}
  </style>
</head>
<body>
  <main class="pub-shell">
    {content_html}
    {toc_html}
  </main>
</body>
</html>"""
    return page.encode("utf-8")


def export_static_public_html(
    vault: Vault,
    note_id: str,
    *,
    static_password: str = "",
) -> tuple[str, bytes]:
    """Export a single published note as a 100% self-contained static HTML file.

    When static_password is provided, encrypts the rendered HTML with AES-256-GCM +
    PBKDF2-SHA256 (200,000 iterations) and wraps it in an offline WebCrypto unlock page.
    """
    from crypto_backend import AESGCM

    status = get_note_share_status(vault, note_id)
    if not status["enabled"]:
        raise VaultError("Publish this note first before exporting static HTML.", 409)
    snapshot = fetch_public_snapshot(vault, status["slug"])
    if snapshot is None:
        raise VaultError("Published snapshot not found.", 404)

    filename = f"{snapshot['slug']}.html"
    plain_html = render_public_page_html(snapshot, locked=False)
    if not static_password:
        return filename, plain_html

    if not 4 <= len(static_password) <= 128:
        raise VaultError("Static HTML password must be 4–128 characters.")

    salt = os.urandom(16)
    iv = os.urandom(12)
    iterations = 200_000
    key = hashlib.pbkdf2_hmac("sha256", static_password.encode("utf-8"), salt, iterations, dklen=32)
    ciphertext = AESGCM(key).encrypt(iv, plain_html, b"Xotira/static-public/1")

    title = html.escape(snapshot["title"])
    theme = html.escape(snapshot["theme"])
    payload = json.dumps({
        "salt": base64.b64encode(salt).decode("ascii"),
        "iv": base64.b64encode(iv).decode("ascii"),
        "iter": iterations,
        "ct": base64.b64encode(ciphertext).decode("ascii"),
    })

    encrypted_page = f"""<!doctype html>
<html lang="en" data-pub-theme="{theme}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>{title} — Protected Note (Memory map)</title>
  <style>
    :root {{ --bg:#14161b; --surface:#1c1f26; --border:#2b303c; --text:#e6e8ee; --muted:#9aa3b2; --accent:#a78bfa; }}
    :root[data-pub-theme="paper"] {{ --bg:#faf8f4; --surface:#f1eee7; --border:#ded9ce; --text:#1c1917; --muted:#57534e; --accent:#6d28d9; }}
    * {{ box-sizing:border-box; }}
    body {{ margin:0; min-height:100vh; display:grid; place-items:center; padding:24px; background:var(--bg); color:var(--text); font:15px/1.6 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif; }}
    .lock-card {{ width:min(100%,420px); padding:28px; border:1px solid var(--border); border-radius:12px; background:var(--surface); text-align:center; }}
    .lock-card h1 {{ margin:0 0 8px; font-size:1.45rem; }}
    .lock-card p {{ margin:0 0 16px; color:var(--muted); font-size:.9rem; }}
    .lock-form {{ display:flex; gap:8px; }}
    .lock-form input {{ flex:1; padding:9px 12px; border-radius:7px; border:1px solid var(--border); background:var(--bg); color:var(--text); }}
    .lock-form button {{ padding:9px 16px; border-radius:7px; border:0; background:var(--accent); color:#fff; font-weight:600; cursor:pointer; }}
    .lock-err {{ color:#ef4444; font-size:.85rem; margin-top:12px; min-height:1.2em; }}
  </style>
</head>
<body>
  <section class="lock-card">
    <h1>{title}</h1>
    <p>This standalone Memory map note is encrypted with AES-256-GCM. Enter the password to decrypt locally in your browser.</p>
    <form id="unlock-form" class="lock-form">
      <input id="pw" type="password" placeholder="Password…" required autocomplete="current-password">
      <button type="submit">Decrypt</button>
    </form>
    <div id="err" class="lock-err" role="alert"></div>
  </section>
  <script id="xotira-payload" type="application/json">{payload}</script>
  <script>
    const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    document.getElementById("unlock-form").addEventListener("submit", async e => {{
      e.preventDefault();
      const err = document.getElementById("err");
      err.textContent = "";
      try {{
        const data = JSON.parse(document.getElementById("xotira-payload").textContent);
        const enc = new TextEncoder();
        const keyMat = await crypto.subtle.importKey("raw", enc.encode(document.getElementById("pw").value), "PBKDF2", false, ["deriveKey"]);
        const key = await crypto.subtle.deriveKey(
          {{ name: "PBKDF2", salt: b64(data.salt), iterations: data.iter, hash: "SHA-256" }},
          keyMat,
          {{ name: "AES-GCM", length: 256 }},
          false,
          ["decrypt"]
        );
        const plain = await crypto.subtle.decrypt(
          {{ name: "AES-GCM", iv: b64(data.iv), additionalData: enc.encode("Xotira/static-public/1") }},
          key,
          b64(data.ct)
        );
        document.open();
        document.write(new TextDecoder().decode(plain));
        document.close();
      }} catch {{
        err.textContent = "Incorrect password or corrupted file.";
      }}
    }});
  </script>
</body>
</html>"""
    return filename, encrypted_page.encode("utf-8")


def export_static_public_site_zip(vault: Vault) -> tuple[bytes, int]:
    """Bundle ONLY published notes into a ready-to-deploy static site ZIP (Cloudflare Pages / Netlify / GitHub Pages).

    Produces:
    - p/<slug>/index.html for each published note
    - 404.html (generic not-found page with zero vault leakage)
    - _headers (security headers for Cloudflare Pages & Netlify)
    """
    import io
    from zipfile import ZIP_DEFLATED, ZipFile

    shares = list_public_shares(vault)
    if not shares:
        raise VaultError("Publish at least one note before exporting a public site bundle.", 409)

    buffer = io.BytesIO()
    exported = 0
    with ZipFile(buffer, "w", ZIP_DEFLATED) as archive:
        for item in shares:
            snapshot = fetch_public_snapshot(vault, item["slug"])
            if snapshot is None:
                continue
            html_bytes = render_public_page_html(snapshot, locked=False)
            archive.writestr(f"p/{snapshot['slug']}/index.html", html_bytes)
            exported += 1
        archive.writestr(
            "404.html",
            b"<!doctype html><meta charset='utf-8'><meta name='robots' content='noindex'><title>Not found</title><p>This page does not exist or is private.</p>",
        )
        archive.writestr(
            "_headers",
            (
                "/*\n"
                "  X-Content-Type-Options: nosniff\n"
                "  X-Frame-Options: DENY\n"
                "  Referrer-Policy: no-referrer\n"
                "  X-Robots-Tag: noindex, nofollow\n"
            ).encode("utf-8"),
        )
    return buffer.getvalue(), exported
