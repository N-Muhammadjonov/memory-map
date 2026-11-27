"""Run Xotira on a private, per-launch loopback address."""

from __future__ import annotations

import argparse
from contextlib import closing
import base64
import io
import json
import os
import posixpath
import re
import secrets
import shutil
import sqlite3
import sys
import tempfile
import time
import webbrowser
import zipfile
from datetime import datetime
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Event, RLock, Thread
from typing import Any, BinaryIO, Callable
from urllib.parse import parse_qs, quote, urlsplit

from crypto_backend import InvalidTag

from vault import MAX_ATTACHMENT, MAX_MARKUP, Vault, VaultError, clean_title, map_wikilinks, note_body, note_tags, title_key
import ai_providers
from ai import proposals as ai_proposals
from ai.context import configure_visibility, hidden_notes
from ai.service import AIService
import build_config
import hosting
import markdown_mirror
import settings
from telemetry import VERSION, Telemetry, check_for_updates
from update_manager import UpdateManager
from account_auth import AccountClient
from account_transfer import MAX_TRANSFER_PAYLOAD, build_encrypted_transfer_zip, import_encrypted_transfer_zip
from public_share import (
    configure_note_share,
    export_static_public_html,
    export_static_public_site_zip,
    fetch_public_snapshot,
    get_note_share_status,
    list_public_shares,
    make_unlock_cookie,
    render_public_page_html,
    verify_share_password,
    verify_unlock_cookie,
)
from document_preview import preview_office
from archive_import import zip_entries
from folder_import import MAX_IMPORT, read_import, valid_part
from portable_archive import SNAPSHOT, restore_snapshot
from academic_export import export_note_docx, export_note_epub, parse_bibtex_to_note
from snippet_runner import MAX_SOURCE, SnippetError, inspect_snippet, run_snippet, worker as snippet_worker
from agent_api import brain_stats, build_context_pack, export_brain_json, find_unlinked_mentions, search_brain, semantic_search_brain

WEB = Path(__file__).with_name("web")
STATIC = {
    "/": ("index.html", "text/html"),
    "/manifest.webmanifest": ("manifest.webmanifest", "application/manifest+json"),
    "/assets/memory-map.svg": ("assets/memory-map.svg", "image/svg+xml"),
    "/assets/memory-map-192.png": ("assets/memory-map-192.png", "image/png"),
    "/assets/memory-map-512.png": ("assets/memory-map-512.png", "image/png"),
    "/i18n.js": ("i18n.js", "text/javascript"),
    "/home.js": ("home.js", "text/javascript"),
    "/tour.js": ("tour.js", "text/javascript"),
    "/styles.css": ("styles.css", "text/css"),
    "/trash-drop.js": ("trash-drop.js", "text/javascript"),
    "/app.js": ("app.js", "text/javascript"),
    "/ai-panel.js": ("ai-panel.js", "text/javascript"),
    "/graph-topics.js": ("graph-topics.js", "text/javascript"),
    "/graph-suggestions.js": ("graph-suggestions.js", "text/javascript"),
    "/graph.js": ("graph.js", "text/javascript"),
    "/notion-editor.js": ("notion-editor.js", "text/javascript"),
    "/editor.js": ("editor.js", "text/javascript"),
    "/database-view.js": ("database-view.js", "text/javascript"),
    "/work-planning.js": ("work-planning.js", "text/javascript"),
    "/command-palette.js": ("command-palette.js", "text/javascript"),
    "/study-mode.js": ("study-mode.js", "text/javascript"),
    "/templates.js": ("templates.js", "text/javascript"),
    "/folder.js": ("folder.js", "text/javascript"),
    "/viewer.js": ("viewer.js", "text/javascript"),
    "/attachment-markup.js": ("attachment-markup.js", "text/javascript"),
    "/mind-map.js": ("mind-map.js", "text/javascript"),
    "/mind-map-model.js": ("mind-map-model.js", "text/javascript"),
    "/canvas-board.js": ("canvas-board.js", "text/javascript"),
    "/shape-recognition.js": ("shape-recognition.js", "text/javascript"),
    "/note-tools.js": ("note-tools.js", "text/javascript"),
    "/native-downloads.js": ("native-downloads.js", "text/javascript"),
    "/markdown.js": ("markdown.js", "text/javascript"),
    "/code-tools.js": ("code-tools.js", "text/javascript"),
    "/note-renderers.js": ("note-renderers.js", "text/javascript"),
    "/properties.js": ("properties.js", "text/javascript"),
    "/vendor/marked.mjs": ("vendor/marked.mjs", "text/javascript"),
    "/vendor/katex.mjs": ("vendor/katex.mjs", "text/javascript"),
    "/pdf/pdf.mjs": ("pdf/pdf.mjs", "text/javascript"),
    "/pdf/pdf.worker.mjs": ("pdf/pdf.worker.mjs", "text/javascript"),
}
MAX_REQUEST = 17 * 1024 * 1024
BACKUP_INTERVAL = 300
CONTENT_POLICY = (
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; manifest-src 'self'; "
    "img-src 'self' blob: data:; media-src blob:; worker-src 'self'; font-src 'self' blob: data:; "
    "base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'"
)
PUBLIC_CONTENT_POLICY = (
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; "
    "img-src data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'"
)
NOTE_PATH = re.compile(r"/api/notes/([0-9a-f]{32})(?:/files(?:/([0-9a-f]{32}))?)?")
NOTE_ACTION_PATH = re.compile(r"/api/notes/([0-9a-f]{32})/(pin|mentions|append|entity|history|share|host|export|lock)")
PUBLIC_NOTE_PATH = re.compile(r"/p/([a-z0-9][a-z0-9-]{2,78}[a-z0-9])(?:/(unlock))?")
AGENT_NOTE_PATH = re.compile(r"/api/agent/notes/([0-9a-f]{32})(?:/(append))?")
UPLOAD_PATH = re.compile(r"/api/notes/([0-9a-f]{32})/files")
PDF_ASSET = re.compile(r"/pdf/(?:cmaps/[a-zA-Z0-9_-]+\.bcmap|standard_fonts/[a-zA-Z0-9_-]+\.(?:pfb|ttf))")
EXPORT_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def filename_stem(name: str) -> str:
    return EXPORT_NAME.sub("_", name).strip(" .")[:100] or "Qayd"


def add_markdown(vault: Vault, archive: zipfile.ZipFile, prefix: str = "") -> None:
    protected_ids = vault.protected_note_ids()
    notes = [note for note in vault.notes.values() if not note.trashed and not note.storage_only and note.id not in protected_ids]
    names: dict[str, str] = {}
    lookup: dict[str, str] = {}
    used: set[str] = set()
    for note in notes:
        base = filename_stem(note.title)
        label = base
        number = 2
        while title_key(label) in used:
            label = f"{base} ({number})"
            number += 1
        used.add(title_key(label))
        names[note.id] = label
        lookup.update((title_key(name), label) for name in [note.title, *note.aliases])
    output_paths = {note.id: f"{note.source}/{note.path}" if note.path else f"{names[note.id]}.md" for note in notes}
    attachment_paths = {}
    for item in vault.list_attachments():
        if item["noteId"] in protected_ids:
            continue
        if item.get("managed"):
            _, contents = vault.attachment(item["noteId"], item["id"])
            asset = f"{item['source']}/{item['path']}"
            archive.writestr(prefix + asset, contents)
        else:
            asset = f"assets/{item['id']}/{filename_stem(item['name'])}"
        attachment_paths[item["id"]] = asset
    for note in notes:
        def replace_link(match: re.Match[str]) -> str:
            original = match.group(1)
            target = lookup.get(title_key(original))
            if target is None or target == original.strip():
                return match.group(0)
            return "[[" + target + match.group(0)[2 + len(original):]

        path = output_paths[note.id]
        text = note.body if note.path else map_wikilinks(note.body, replace_link)

        def replace_stable(match: re.Match[str]) -> str:
            paths = output_paths if match[1] == "xotira" else attachment_paths
            target = paths.get(match[2])
            if not target:
                return match[0]
            relative = posixpath.relpath(target, posixpath.dirname(path) or ".")
            return "](" + quote(relative, safe="/") + ")"

        text = re.sub(r"\]\((xotira|attachment):([0-9a-f]{32})\)", replace_stable, text)
        files = vault.get_note(note.id, resolve=False)["attachments"]
        links = []
        for file in files:
            name, contents = vault.attachment(note.id, file["id"])
            asset_path = attachment_paths[file["id"]]
            archive.writestr(prefix + asset_path, contents)
            display = name.replace("[", "(").replace("]", ")")
            relative = posixpath.relpath(asset_path, posixpath.dirname(path) or ".")
            links.append(f"- [{display}]({quote(relative, safe='/')})")
        if links:
            text += "\n\n## Biriktirmalar\n\n" + "\n".join(links) + "\n"
        archive.writestr(prefix + path, text)


class Server(ThreadingHTTPServer):
    def __init__(self, vault: Vault, backup_dir: Path | None, *, port: int = 0, ai_developer: bool = False) -> None:
        self.vault = vault
        vault.unpublished_hook = lambda ids: hosting.unhost(vault, ids)
        self.telemetry = Telemetry(vault, os.environ.get("XOTIRA_STATS_URL") or build_config.STATS_URL,
                                   require_consent=build_config.REQUIRE_TELEMETRY_CONSENT)
        self.updater = UpdateManager(default_vault().parent / "updates",
                                     os.environ.get("XOTIRA_GITHUB_REPO") or build_config.GITHUB_REPO, VERSION)
        self.account = AccountClient(os.environ.get("XOTIRA_AUTH_URL") or build_config.AUTH_URL,
                                     os.environ.get("XOTIRA_AUTH_KEY") or build_config.AUTH_KEY,
                                     build_config.AUTH_SITE_URL)
        self.token = secrets.token_urlsafe(32)
        self.public_cookie_secret = secrets.token_urlsafe(32)
        self.agent_key = secrets.token_urlsafe(24)
        self.agent_enabled = False
        self.agent_proposals_enabled = False
        self.agent_proposals: dict[str, dict[str, Any]] = {}
        self.mutex = RLock()
        self.native_close_event = Event()
        self.native_close_pending = False
        self.native_close_ok = False
        self.ai = AIService(vault, self.mutex, developer=ai_developer)
        self.backup_dir = backup_dir
        self.backup_error = ""
        self.last_backup = ""
        self.backup_changes = 0
        self.backup_at = 0.0
        self.mirror_changes = 0
        self.mirror_at = 0.0
        super().__init__(("127.0.0.1", port), Handler)
        self.host = f"127.0.0.1:{self.server_port}"
        self.origin = f"http://{self.host}"

    def prepare_native_close(self, trigger: Callable[[str], None]) -> bool:
        """Let the editor persist pending changes before stopping its local server."""
        with self.mutex:
            if self.vault.cipher is None:
                return True
            if self.native_close_pending:
                return False
            self.native_close_pending = True
            self.native_close_ok = False
            self.native_close_event.clear()
        try:
            trigger("window.memoryMapPrepareClose?.()")
            return self.native_close_event.wait(15) and self.native_close_ok
        finally:
            with self.mutex:
                self.native_close_pending = False

    def close_agent_access(self) -> None:
        self.agent_enabled = False
        self.agent_proposals_enabled = False
        self.agent_key = secrets.token_urlsafe(24)
        self.agent_proposals.clear()

    def session_status(self) -> dict[str, bool]:
        status = self.vault.status()
        if not status["unlocked"]:
            self.ai.reset()
            self.account.reset()
        if not status["unlocked"] and self.agent_enabled:
            self.close_agent_access()
        return status

    def restore_backup_status(self) -> None:
        stored = settings.load(self.vault, "backup_status", {})
        if not self.last_backup:
            self.last_backup = stored.get("lastBackup", "")

    def record_backup(self, *, automatic: bool = False) -> None:
        self.last_backup = datetime.now().astimezone().isoformat(timespec="seconds")
        if self.vault.cipher is not None:
            settings.save(self.vault, "backup_status", {"lastBackup": self.last_backup})
        # A manually downloaded backup does not fulfill the scheduled folder backup.
        if automatic:
            self.backup_changes = self.vault.changes
        self.backup_error = ""

    def current_proposals(self) -> dict[str, dict[str, Any]]:
        now = time.monotonic()
        for proposal_id in [key for key, value in self.agent_proposals.items() if value["expires"] <= now]:
            del self.agent_proposals[proposal_id]
        return self.agent_proposals

    def service_actions(self) -> None:
        if not self.mutex.acquire(blocking=False):
            return
        try:
            self.session_status()
            self.updater.check()
            now = time.monotonic()
            if self.backup_dir is None or self.vault.changes == self.backup_changes or now < self.backup_at:
                return
            self.backup_at = now + BACKUP_INTERVAL
            name = f"MemoryMap-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(4)}.xotira"
            try:
                self.vault.backup(self.backup_dir / name)
                self.record_backup(automatic=True)
            except (OSError, sqlite3.Error, VaultError):
                self.backup_error = "Avtomatik zaxira olinmadi. Disk ulanganini va bo‘sh joyni tekshiring."
                self.backup_at = now + 30
                return
        finally:
            if self.vault.cipher is not None and self.vault.changes != self.mirror_changes and time.monotonic() >= self.mirror_at:
                self.mirror_at = time.monotonic() + 5
                try:
                    cfg = markdown_mirror.get_config(self.vault)
                    if cfg["enabled"] and cfg["dir"]:
                        markdown_mirror.sync_mirror(self.vault)
                        self.mirror_changes = self.vault.changes
                except (OSError, sqlite3.Error, VaultError):
                    pass
            self.mutex.release()


class Handler(BaseHTTPRequestHandler):
    timeout = 15
    server: Server

    def setup(self) -> None:
        self.request.settimeout(10)
        super().setup()

    def log_message(self, message: str, *args: Any) -> None:
        return

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        self.write_json({"error": message or HTTPStatus(code).phrase}, code)

    def start_response(
        self,
        status: int,
        size: int | None,
        content_type: str,
        *,
        filename: str = "",
        csp: str = CONTENT_POLICY,
        extra_headers: list[tuple[str, str]] | None = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        if size is not None:
            self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", csp)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        if filename:
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(filename, safe='')}")
        for header_name, header_val in (extra_headers or []):
            self.send_header(header_name, header_val)
        self.end_headers()

    def write_json(self, value: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.start_response(status, len(body), "application/json; charset=utf-8")
        self.wfile.write(body)

    def download(self, file: BinaryIO, size: int, name: str) -> None:
        self.start_response(200, size, "application/octet-stream", filename=name)
        shutil.copyfileobj(file, self.wfile)

    def check_request(self, *, api: bool, agent_route: bool = False) -> None:
        host_headers = self.headers.get_all("Host") or []
        allowed_hosts = {self.server.host, f"localhost:{self.server.server_port}"}
        allowed_origins = {self.server.origin, f"http://localhost:{self.server.server_port}"}
        if len(host_headers) != 1 or host_headers[0] not in allowed_hosts:
            raise VaultError("Address not allowed.", 403)
        origins = self.headers.get_all("Origin") or []
        origin = origins[0] if len(origins) == 1 else None
        if len(origins) > 1 or (origin is not None and origin not in allowed_origins):
            raise VaultError("Origin not allowed.", 403)
        if api and self.headers.get("Sec-Fetch-Site") == "cross-site":
            raise VaultError("Cross-site requests are not allowed.", 403)
        if api and any(len(self.headers.get_all(name) or []) > 1 for name in ("Authorization", "X-Brain-Key")):
            raise VaultError("Invalid credentials.", 401)
        if agent_route:
            if not self.server.agent_enabled:
                raise VaultError("The AI Brain API is off. Enable it in Memory map.", 403)
            auth = self.headers.get("Authorization", "").encode("latin-1")
            x_key = self.headers.get("X-Brain-Key", "").encode("latin-1")
            ok_session = secrets.compare_digest(auth, f"Bearer {self.server.token}".encode("ascii"))
            ok_agent = (
                secrets.compare_digest(auth, f"Bearer {self.server.agent_key}".encode("ascii"))
                or secrets.compare_digest(x_key, self.server.agent_key.encode("ascii"))
            )
            if not (ok_session or ok_agent):
                raise VaultError("Invalid AI Brain API key.", 401)
            if ok_session and self.command == "POST" and origin not in allowed_origins:
                raise VaultError("Origin not allowed.", 403)
            return
        if api:
            token = self.headers.get("Authorization", "").encode("latin-1")
            expected = f"Bearer {self.server.token}".encode("ascii")
            if not secrets.compare_digest(token, expected):
                raise VaultError("Start Memory map from its launcher.", 401)
        if self.command == "POST" and origin not in allowed_origins:
            raise VaultError("Origin not allowed.", 403)

    def body_length(self, limit: int) -> int:
        if self.headers.get("Transfer-Encoding"):
            raise VaultError("Invalid request content type.", 415)
        lengths = self.headers.get_all("Content-Length") or []
        if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit():
            raise VaultError("The request requires a content length.", 411)
        size = int(lengths[0])
        if size > limit:
            raise VaultError("The file or request exceeds the size limit.", 413)
        return size

    def read_body(self, limit: int) -> bytes:
        size = self.body_length(limit)
        body = self.rfile.read(size)
        if len(body) != size:
            raise VaultError("The file transfer was incomplete. Try again.")
        return body

    def read_json(self, limit: int = MAX_REQUEST) -> dict[str, Any]:
        if self.headers.get_content_type() != "application/json":
            raise VaultError("Invalid request content type.", 415)
        body = self.read_body(limit)
        try:
            result = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeError) as error:
            raise VaultError("Could not read the request.") from error
        if not isinstance(result, dict):
            raise VaultError("Invalid request format.")
        return result

    def do_GET(self) -> None:
        self.handle_request()

    def do_POST(self) -> None:
        self.handle_request()

    def handle_request(self) -> None:
        try:
            parts = urlsplit(self.path)
            route = parts.path
            public_match = PUBLIC_NOTE_PATH.fullmatch(route)
            if public_match:
                self.check_request(api=False)
                self.handle_public_page(public_match.group(1), unlock=bool(public_match.group(2)))
                return
            api = route.startswith("/api/")
            agent_route = route.startswith("/api/agent/") and route != "/api/agent/config"
            self.check_request(api=api, agent_route=agent_route)
            if route == "/account/callback" and self.command == "GET":
                query = parse_qs(parts.query)
                with self.server.mutex:
                    self.server.vault.require_unlocked()
                    self.server.account.finish_google(query.get("nonce", [""])[0], query.get("code", [""])[0])
                content = b"<!doctype html><html lang='en'><meta charset='utf-8'><title>Memory map</title><h1>Account connected</h1><p>Return to the original Memory map window.</p></html>"
                self.start_response(200, len(content), "text/html; charset=utf-8")
                self.wfile.write(content)
                return
            if not api and self.command == "GET":
                asset = STATIC.get(route)
                if asset:
                    name, mime = asset
                    data = (WEB / name).read_bytes()
                    self.start_response(200, len(data), mime if mime == "image/png" else mime + "; charset=utf-8")
                    self.wfile.write(data)
                    return
                if PDF_ASSET.fullmatch(route):
                    path = WEB / route.lstrip("/")
                    if path.is_file():
                        data = path.read_bytes()
                        self.start_response(200, len(data), "application/octet-stream")
                        self.wfile.write(data)
                        return
            if not api:
                raise VaultError("Page not found.", 404)
            query = parse_qs(parts.query)
            if route == "/api/ai/send" and self.command == "POST":
                body = self.read_json(8192)
                with self.server.mutex:
                    self.server.vault.require_unlocked()
                    job = self.server.ai.begin(body)
                self.close_connection = True
                with closing(self.server.ai.stream(*job)) as stream:
                    try:
                        self.start_response(200, None, "application/x-ndjson; charset=utf-8")
                        for event in stream:
                            self.wfile.write((json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8"))
                            self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
                        job[2].set()
                    except (VaultError, ValueError):
                        self.wfile.write(b'{"type":"error","code":"provider_error"}\n')
                return
            if route in ("/api/snippets/check", "/api/snippets/run") and self.command == "POST":
                with self.server.mutex:
                    self.server.vault.require_unlocked()
                body = self.read_json(MAX_SOURCE * 6 + 128)
                try:
                    action = inspect_snippet if route.endswith("/check") else run_snippet
                    result = action(body.get("language"), body.get("source"))
                except SnippetError as error:
                    raise VaultError(str(error), 400) from error
                self.write_json(result)
                return
            if route == "/api/import/zip" and self.command == "POST":
                if self.headers.get_content_type() != "application/octet-stream":
                    raise VaultError("Invalid ZIP upload content type.", 415)
                length = self.body_length(MAX_IMPORT)
                source = query.get("source", [""])[0]
                if not valid_part(source):
                    raise VaultError("Invalid import folder name.")
                notion = query.get("format", [""])[0] in ("notion", "web")
                with self.server.mutex:
                    self.server.vault.require_unlocked()
                with tempfile.TemporaryFile() as temporary:
                    while length:
                        chunk = self.rfile.read(min(length, 1024**2))
                        if not chunk:
                            raise VaultError("The ZIP upload was interrupted.")
                        temporary.write(chunk)
                        length -= len(chunk)
                    temporary.seek(0)
                    try:
                        with zipfile.ZipFile(temporary) as archive, self.server.mutex:
                            summary = dict(skipped=0, converted=0, unconverted=0)
                            entries = zip_entries(archive, notion=notion, summary=summary)
                            counts = self.server.vault.import_folder(source, entries)
                            self.write_json({**counts, **summary}, 201)
                    except zipfile.BadZipFile as error:
                        raise VaultError("Could not read the ZIP file.") from error
                return
            if route == "/api/transfer/import" and self.command == "POST":
                if self.headers.get_content_type() != "application/octet-stream":
                    raise VaultError("Invalid encrypted transfer ZIP content type.", 415)
                b64_pass = self.headers.get("X-Transfer-Passphrase-B64", "").strip()
                if b64_pass:
                    try:
                        passphrase = base64.b64decode(b64_pass.encode("ascii"), validate=True).decode("utf-8")
                    except Exception as error:
                        raise VaultError("Invalid transfer passphrase encoding.", 400) from error
                else:
                    passphrase = self.headers.get("X-Transfer-Passphrase", "")
                conflict = query.get("conflict", ["rename"])[0]
                with self.server.mutex:
                    self.server.vault.require_unlocked()
                zip_bytes = self.read_body(MAX_TRANSFER_PAYLOAD)
                with self.server.mutex:
                    summary = import_encrypted_transfer_zip(
                        self.server.vault, zip_bytes, passphrase, conflict=conflict
                    )
                    self.write_json(summary, 201)
                return
            if route == "/api/import/folder" and self.command == "POST":
                if self.headers.get_content_type() != "application/octet-stream":
                    raise VaultError("Invalid folder upload content type.", 415)
                length = self.body_length(MAX_IMPORT)
                with self.server.mutex:
                    self.server.vault.require_unlocked()
                    source, entries = read_import(self.rfile, length)
                    self.write_json(self.server.vault.import_folder(source, entries), 201)
                return
            if self.command == "POST" and self.headers.get_content_type() == "application/octet-stream":
                upload = UPLOAD_PATH.fullmatch(route)
                name = query.get("name", [""])[0]
                if not upload or not name:
                    raise VaultError("Provide a note and a file name.")
                with self.server.mutex:
                    self.server.vault.require_unlocked()
                content = self.read_body(MAX_ATTACHMENT)
                with self.server.mutex:
                    self.server.vault.require_note_unlocked(upload[1])
                    self.write_json(self.server.vault.store_attachment(upload[1], name, content), 201)
                return
            if route == "/api/updates" and self.command == "GET":
                with self.server.mutex:
                    self.server.vault.require_unlocked(touch=False)
                repo = os.environ.get("XOTIRA_GITHUB_REPO") or build_config.GITHUB_REPO
                self.write_json(check_for_updates(repo))
                if updater := getattr(self.server, "updater", None):
                    updater.check()
                return
            if route == "/api/ai-providers/check" and self.command == "POST":
                with self.server.mutex:
                    self.server.vault.require_unlocked()
                self.write_json({"ok": False, "errorCode": "not_connected"})
                return
            limit = 65_536 if route.startswith("/api/ai/") else MAX_REQUEST
            if query.get("view") == ["markup"]:
                limit = MAX_MARKUP + 8192
            body = self.read_json(limit) if self.command == "POST" else {}
            with self.server.mutex:
                self.handle_api(route, query, body)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            return
        except VaultError as error:
            self.write_json({"error": str(error)}, error.status)
        except (sqlite3.Error, OSError, InvalidTag, UnicodeError, ValueError) as error:
            print(f"Xotira: {type(error).__name__}", file=sys.stderr)
            self.write_json({"error": "The operation failed. Check the vault, available disk space, and backup."}, 500)

    def handle_api(self, route: str, query: dict[str, list[str]], body: dict[str, Any]) -> None:
        vault = self.server.vault
        post = self.command == "POST"
        if route == "/api/status" and not post:
            self.write_json({
                **self.server.session_status(), "backupError": self.server.backup_error,
                "lastBackup": self.server.last_backup,
                "automaticBackup": self.server.backup_dir is not None,
            })
            return
        if route == "/api/native-close-ready" and post:
            if not self.server.native_close_pending or type(body.get("ok")) is not bool:
                raise VaultError("No native window close is pending.", 409)
            self.server.native_close_ok = body["ok"]
            self.server.native_close_event.set()
            self.write_json({"ok": True})
            return
        if route in {"/api/unlock", "/api/create"} and post:
            self.server.session_status()
            vault.unlock(body.get("password"), create=route == "/api/create")
            self.server.restore_backup_status()
            self.write_json({"ok": True})
            return
        if route == "/api/recover" and post:
            self.server.session_status()
            if vault.cipher is not None:
                raise VaultError("Lock the vault before resetting its password with a recovery key.", 409)
            vault.unlock_with_recovery(body.get("recoveryKey"), body.get("newPassword"))
            self.server.restore_backup_status()
            self.write_json({"ok": True})
            return
        if route == "/api/lock" and post:
            vault.lock()
            if ai := getattr(self.server, "ai", None):
                ai.reset()
            self.server.close_agent_access()
            if account := getattr(self.server, "account", None):
                account.reset()
            self.write_json({"ok": True})
            return
        if route.startswith("/api/agent/") and route != "/api/agent/config":
            if not self.server.session_status()["unlocked"]:
                raise VaultError("Unlock Memory map first.", 423)
            self.check_request(api=True, agent_route=True)
            with vault.passive(), vault.ai_scope():
                self.handle_agent_api(route, query, body)
            return
        vault.require_unlocked(touch=route != "/api/reminders" or post)
        if route == "/api/touch" and post:
            self.write_json({"ok": True})
            return
        if route == "/api/update-settings":
            updater = self.server.updater
            if post:
                if type(body.get("enabled")) is not bool or not updater.status()["supported"]:
                    raise VaultError("Automatic updates require an installed desktop build.")
                self.write_json(updater.configure(body["enabled"]))
            else:
                self.write_json(updater.status())
            return
        if route == "/api/account/owner-stats" and not post:
            self.write_json(self.server.account.owner_stats())
            return
        if route == "/api/account":
            account = self.server.account
            if not post:
                self.write_json(account.status())
            elif body.get("action") in ("register", "sign-in"):
                self.write_json(account.email(body.get("email"), body.get("password"), register=body["action"] == "register"))
            elif body.get("action") == "google":
                self.write_json({"url": account.begin_google(self.server.origin)})
            elif body.get("action") == "sign-out":
                self.write_json(account.sign_out())
            else:
                raise VaultError("Choose an account action.")
            return
        if route.startswith("/api/ai/"):
            self.handle_ai_api(route, query, body)
            return
        self.server.telemetry.tick()
        if route == "/api/telemetry":
            if post and "consent" in body:
                self.write_json(self.server.telemetry.set_consent(body.get("consent")))
            elif post:
                self.server.telemetry.feature(body.get("feature"), body.get("lang"))
                self.write_json({"ok": True})
            else:
                self.write_json(self.server.telemetry.status())
            return
        if route == "/api/feedback" and post:
            self.server.telemetry.feature(None, body.get("lang"))
            self.server.telemetry.send_feedback(
                body.get("kind"), body.get("message"), body.get("contact", ""), body.get("screenshot", "")
            )
            self.write_json({"ok": True})
            return
        if self.server.telemetry.blocked():
            raise VaultError("Agree to anonymous statistics to use Memory map.", 428)
        self.server.telemetry.observe(route, post)
        if route == "/api/ai-providers":
            self.write_json(ai_providers.save_connection(vault, body) if post else ai_providers.connection_status(vault))
            return
        if route == "/api/database/views":
            views = settings.save_database_view(vault, body) if post else settings.load(vault, "database_views", [])
            self.write_json({"views": views})
            return
        if route == "/api/search" and not post:
            q = query.get("q", [""])[0][:400]
            tag = query.get("tag", [""])[0][:60]
            if query.get("mode", [""])[0] == "semantic":
                self.write_json(semantic_search_brain(vault, q, tag=tag, limit=30))
            else:
                self.write_json(search_brain(vault, q, tag=tag, limit=30))
            return
        if route == "/api/tools/bibtex" and post:
            draft = parse_bibtex_to_note(body.get("bibtex", ""))
            ids = vault.create_notes([draft])
            self.write_json(vault.get_note(ids[0]), 201)
            return
        if route == "/api/clip" and post:
            raw_title = str(body.get("title") or "Web Clip").strip()[:115] or "Web Clip"
            clip_url = str(body.get("url") or "").strip()[:1000]
            quote_text = str(body.get("quote") or "").strip()[:40_000]
            extra_body = str(body.get("body") or "").strip()[:120_000]
            tags = body.get("tags") if isinstance(body.get("tags"), list) else ["WebClip"]
            parts_md = [f"# {raw_title}", ""]
            if clip_url and re.match(r"^https?://", clip_url, re.I):
                parts_md.append(f"- **Source:** [{clip_url}]({clip_url})")
                parts_md.append("")
            if quote_text:
                parts_md.extend(["> " + line for line in quote_text.splitlines()])
                parts_md.append("")
            if extra_body:
                parts_md.append(extra_body)
            ids = vault.create_notes([{
                "title": raw_title,
                "body": "\n".join(parts_md).strip(),
                "tags": tags,
                "useAvailableTitle": True,
            }])
            self.write_json(vault.get_note(ids[0]), 201)
            return
        if route == "/api/graph" and not post:
            self.write_json(vault.graph(query.get("q", [""])[0][:200], query.get("trash") == ["1"]))
            return
        if route == "/api/mind-maps" and post:
            self.write_json(vault.create_mind_map(body), 201)
            return
        if route == "/api/graph/position" and post:
            vault.move_graph_node(body.get("id"), body.get("position"))
            self.write_json({"ok": True})
            return
        if route == "/api/trash" and post:
            action = body.get("action")
            attachment = body.get("file")
            if isinstance(attachment, dict) and action in ("move", "restore", "delete"):
                vault.trash_attachment(attachment.get("noteId"), attachment.get("id"), action)
                self.write_json({"ok": True})
                return
            expected = body.get("note")
            if (body.get("action") == "delete" and isinstance(expected, dict)) or body.get("action") == "empty":
                self.write_json({"ids": vault.delete_trashed(expected if body["action"] == "delete" else None)})
                return
            raise VaultError("Invalid trash action.")
        if route == "/api/reminders":
            if post:
                self.write_json(vault.set_reminder(body.get("noteId"), body.get("at"), body.get("expected")))
            else:
                self.write_json({"reminders": vault.reminders()})
            return
        if route == "/api/tasks":
            self.write_json(vault.toggle_task(body) if post else {"tasks": vault.tasks()})
            return
        if route == "/api/files" and not post:
            self.write_json({"files": vault.list_attachments()})
            return
        if route == "/api/entities/migrate" and post:
            self.write_json(vault.migrate_legacy_entities(body.get("records")))
            return
        if route == "/api/notes" and post:
            self.write_json({"ids": vault.create_notes(body.get("notes"))}, 201)
            return
        if route == "/api/mirror/config":
            if post:
                cfg = markdown_mirror.set_config(vault, body.get("dir", ""), body.get("enabled", False))
                if cfg["enabled"] and cfg["dir"]:
                    cfg = markdown_mirror.sync_mirror(vault)
                    self.server.mirror_changes = vault.changes
                self.write_json(cfg)
            else:
                self.write_json(markdown_mirror.get_config(vault))
            return
        if route == "/api/mirror/sync" and post:
            cfg = markdown_mirror.sync_mirror(vault)
            self.server.mirror_changes = vault.changes
            self.write_json(cfg)
            return
        if route == "/api/recovery-key":
            if post:
                self.write_json({"recoveryKey": vault.generate_recovery_key()})
            else:
                self.write_json({"configured": vault.has_recovery_key()})
            return
        if route == "/api/backup" and not post:
            with tempfile.TemporaryDirectory(prefix="xotira-") as directory:
                name = f"MemoryMap-{datetime.now().strftime('%Y%m%d-%H%M%S')}.xotira"
                path = Path(directory) / name
                vault.backup(path)
                with path.open("rb") as file:
                    self.download(file, path.stat().st_size, name)
                try:
                    self.server.record_backup()
                except (OSError, sqlite3.Error, VaultError):
                    self.server.backup_error = "The backup was downloaded, but its date could not be saved."
            return
        if route in {"/api/export", "/api/export/portable"} and not post:
            portable = route.endswith("/portable")
            with tempfile.TemporaryDirectory(prefix="xotira-export-") as directory, tempfile.TemporaryFile() as file:
                with zipfile.ZipFile(file, "w", zipfile.ZIP_DEFLATED) as archive:
                    add_markdown(vault, archive, "content/" if portable else "")
                    if portable:
                        snapshot = Path(directory) / "vault.xotira"
                        vault.backup(snapshot)
                        archive.write(snapshot, SNAPSHOT, compress_type=zipfile.ZIP_STORED)
                        archive.writestr("xotira/entities.json", json.dumps(export_brain_json(vault), ensure_ascii=False))
                        archive.writestr("xotira/views.json", json.dumps({
                            "schema": "xotira-views/1",
                            "views": [
                                {"id": "table"}, {"id": "kanban", "groupBy": "status"},
                                {"id": "calendar", "dateField": "due"}, {"id": "gallery"},
                            ],
                        }))
                size = file.tell()
                file.seek(0)
                name = "MemoryMap-Portable.zip" if portable else "MemoryMap-Markdown.zip"
                self.download(file, size, name)
            return
        if route == "/api/export/brain" and not post:
            with vault.ai_scope():
                payload = json.dumps(export_brain_json(vault), ensure_ascii=False, indent=2).encode("utf-8")
            self.download(io.BytesIO(payload), len(payload), "MemoryMap-Brain.json")
            return
        if route == "/api/transfer/export" and post:
            zip_bytes, _ = build_encrypted_transfer_zip(
                vault, body.get("passphrase"), note_ids=body.get("noteIds")
            )
            name = f"MemoryMap-Transfer-{datetime.now().strftime('%Y%m%d-%H%M%S')}.zip"
            self.download(io.BytesIO(zip_bytes), len(zip_bytes), name)
            return
        if route == "/api/hosting/config":
            if post:
                self.write_json(hosting.set_config(vault, body.get("url"), body.get("key"), body.get("clear") is True))
            else:
                self.write_json(hosting.config_status(vault))
            return
        if route == "/api/shares" and not post:
            shares = [
                {**item, "url": f"{self.server.origin}/p/{item['slug']}"}
                for item in list_public_shares(vault)
            ]
            self.write_json({"shares": shares})
            return
        if route == "/api/shares/static-bundle" and not post:
            zip_bytes, _ = export_static_public_site_zip(vault)
            self.download(io.BytesIO(zip_bytes), len(zip_bytes), "MemoryMap-Public-Site.zip")
            return
        if route == "/api/review-agent":
            proposals = self.server.current_proposals()
            hidden = hidden_notes(vault)
            for proposal_id in [key for key, item in proposals.items() if item.get("noteId") in hidden]:
                del proposals[proposal_id]
            if not post:
                self.write_json({"proposals": [
                    {"id": key, **{field: value for field, value in item.items() if field != "expires"}}
                    for key, item in proposals.items()
                ]})
                return
            proposal_id = body.get("id")
            item = proposals.get(proposal_id) if isinstance(proposal_id, str) else None
            if item is None:
                raise VaultError("The proposal is missing or has expired.", 404)
            if body.get("decision") == "reject":
                del proposals[proposal_id]
                self.write_json({"ok": True})
                return
            if body.get("decision") != "approve":
                raise VaultError("Choose how to handle the proposal.")
            if item["action"] == "append":
                note = vault.get_note(item["noteId"], resolve=False)
                if note["revision"] != item["revision"]:
                    raise VaultError("The note changed after the proposal. Ask the agent for a new proposal.", 409)
                note = vault.append_to_note(item["noteId"], item["text"])
            else:
                ids = vault.create_notes([{"title": item["title"], "body": item["text"], "tags": item["tags"]}])
                note = vault.get_note(ids[0], resolve=False)
            del proposals[proposal_id]
            self.write_json({"ok": True, "note": note})
            return
        if route == "/api/agent/config":
            if post:
                if body.get("enabled") is False:
                    self.server.close_agent_access()
                elif body.get("enabled") is True:
                    self.server.agent_enabled = True
                if isinstance(body.get("proposals"), bool):
                    self.server.agent_proposals_enabled = self.server.agent_enabled and body["proposals"]
                    if not self.server.agent_proposals_enabled:
                        self.server.agent_proposals.clear()
                if body.get("rotate") is True:
                    self.server.agent_key = secrets.token_urlsafe(24)
                    self.server.agent_proposals.clear()
            self.write_json({
                "enabled": self.server.agent_enabled,
                "proposals": self.server.agent_proposals_enabled,
                "url": self.server.origin,
                "key": self.server.agent_key if self.server.agent_enabled else "",
                "bridgePath": str(Path(__file__).with_name("brain_bridge.py").resolve()),
                "stats": brain_stats(vault),
            })
            return
        action_match = NOTE_ACTION_PATH.fullmatch(route)
        if action_match:
            note_id, action = action_match.groups()
            if action == "entity":
                if post:
                    value = vault.update_entity(note_id, body.get("revision"), body.get("fields"))
                else:
                    vault.require_note_unlocked(note_id)
                    vault.get_note(note_id, resolve=False)
                    value = vault.entity(note_id)
                self.write_json(value)
                return
            if action == "history":
                kind = query.get("kind", ["note"])[0]
                if kind not in {"entity", "note"}:
                    raise VaultError("Invalid version type.")
                raw = query.get("revision", [""])[0]
                if raw and (not raw.isascii() or not raw.isdecimal() or len(raw) > 12):
                    raise VaultError("Invalid version number.")
                revision = int(raw) if raw else None
                if post:
                    if revision is None:
                        raise VaultError("Choose a version.")
                    self.write_json(vault.restore_history(note_id, kind, revision, body.get("expected")))
                else:
                    self.write_json(vault.history(note_id, kind, revision))
                return
            if action == "pin" and post:
                self.write_json({"pinned": vault.set_pinned(note_id, bool(body.get("pinned")))})
                return
            if action == "mentions" and not post:
                self.write_json({"mentions": find_unlinked_mentions(vault, note_id)})
                return
            if action == "append" and post:
                self.write_json(vault.append_to_note(note_id, body.get("text", "")))
                return
            if action == "lock" and post:
                act = body.get("action")
                if act == "unlock":
                    self.write_json(vault.unlock_note(note_id, body.get("password")))
                    return
                if act == "lock":
                    vault.lock_note(note_id)
                    self.write_json({"locked": True})
                    return
                if act == "set":
                    self.write_json(vault.set_note_password(note_id, body.get("password"), body.get("currentPassword", "")))
                    return
                raise VaultError("Invalid note lock action.")
            if action == "export" and not post:
                vault.require_note_unlocked(note_id)
                note = vault.notes.get(note_id)
                if note is None or note.storage_only:
                    raise VaultError("Note not found.", 404)
                fmt = query.get("format", ["docx"])[0].lower()
                stem = filename_stem(note.title)
                if fmt == "docx":
                    data = export_note_docx(note)
                    self.download(io.BytesIO(data), len(data), f"{stem}.docx")
                    return
                if fmt == "epub":
                    data = export_note_epub(note)
                    self.download(io.BytesIO(data), len(data), f"{stem}.epub")
                    return
                raise VaultError("Unsupported export format. Use docx or epub.")
            if action == "share":
                vault.require_note_unlocked(note_id)
                if post and query.get("export") == ["html"]:
                    filename, html_bytes = export_static_public_html(
                        vault, note_id, static_password=str(body.get("password") or "")
                    )
                    self.download(io.BytesIO(html_bytes), len(html_bytes), filename)
                    return
                if post and body.get("enabled") is False:
                    hosting.unhost(vault, [note_id])
                info = configure_note_share(vault, note_id, body) if post else get_note_share_status(vault, note_id)
                info["url"] = f"{self.server.origin}/p/{info['slug']}" if info.get("enabled") else ""
                info["hosting"] = hosting.page_status(vault, note_id)
                self.write_json(info)
                return
            if action == "host" and post:
                vault.require_note_unlocked(note_id)
                if body.get("action") == "publish":
                    self.write_json(hosting.publish(vault, note_id, body.get("password") or ""))
                elif body.get("action") == "remove":
                    hosting.unhost(vault, [note_id])
                    self.write_json(hosting.page_status(vault, note_id))
                else:
                    raise VaultError("Choose publish or remove.")
                return
        target = NOTE_PATH.fullmatch(route)
        if target:
            note_id, attachment_id = target.groups()
            if attachment_id or route.endswith("/files"):
                vault.require_note_unlocked(note_id)
            if attachment_id and query.get("view") == ["markup"]:
                selector = query.get("surface", ["1"])
                if len(selector) != 1 or not re.fullmatch(r"[0-9]{1,6}", selector[0]):
                    raise VaultError("Invalid attachment page.")
                self.write_json(vault.attachment_markup(note_id, attachment_id, int(selector[0]), body if post else None))
                return
            if query.get("view") == ["drawing"]:
                if attachment_id and post:
                    if body.get("delete") is True:
                        self.write_json(vault.delete_drawing(note_id, attachment_id, body.get("revision")))
                    else:
                        self.write_json(vault.update_drawing(note_id, attachment_id, body))
                    return
                if attachment_id:
                    self.write_json(vault.drawing(note_id, attachment_id))
                    return
                if route.endswith("/files") and post:
                    self.write_json(vault.create_drawing(note_id, body), 201)
                    return
            if attachment_id and post and query.get("view") == ["mind-map"]:
                self.write_json(vault.update_mind_map(note_id, attachment_id, body))
                return
            if attachment_id and post:
                self.write_json(vault.update_canvas(note_id, attachment_id, body))
                return
            if attachment_id and not post:
                name, content = vault.attachment(note_id, attachment_id)
                if query.get("view") == ["document"]:
                    self.write_json(preview_office(name, content))
                else:
                    self.download(io.BytesIO(content), len(content), name)
                return
            if route.endswith("/files") and post:
                self.write_json(vault.add_attachment(note_id, body), 201)
                return
            if not route.endswith("/files") and attachment_id is None:
                note = vault.update_note(note_id, body) if post else vault.get_note(note_id)
                self.write_json(note)
                return
        raise VaultError("Action not found.", 404)

    def handle_ai_api(self, route: str, query: dict[str, list[str]], body: dict[str, Any]) -> None:
        service = self.server.ai
        vault = self.server.vault
        post = self.command == "POST"
        if route == "/api/ai/settings":
            status = service.save_config(body) if post else service.status()
            try:
                status["credentialProviders"] = [entry["id"] for entry in ai_providers.connection_status(vault)["providers"]
                                                 if entry["configured"]]
            except (VaultError, OSError, InvalidTag, sqlite3.Error):
                status["credentialProviders"] = []
                status["credentialError"] = True
            self.write_json(status)
        elif route == "/api/ai/credentials" and post:
            if set(body) - {"provider", "remove", "apiKey"}:
                raise VaultError("Invalid credential request.")
            result = ai_providers.save_connection(vault, {**body, "action": "remove" if body.get("remove") is True else "save"})
            self.write_json({"configured": [entry["id"] for entry in result["providers"] if entry["configured"]]})
        elif route == "/api/ai/test" and post:
            name = body.get("provider")
            self.write_json({"ok": service.test_connection(name)})
        elif route == "/api/ai/preview" and post:
            self.write_json(service.prepare(body))
        elif route == "/api/ai/cancel" and post:
            service.stop(body.get("requestId"))
            self.write_json({"ok": True})
        elif route == "/api/ai/proposals":
            if post:
                result = ai_proposals.decide(vault, body, time.time())
                self.write_json({"changed": [item["noteId"] for item in result if item.get("noteId")]})
            else:
                self.write_json({"proposals": ai_proposals.visible_records(vault, time.time())})
        elif route == "/api/ai/visibility":
            note_id = body.get("noteId") if post else query.get("noteId", [""])[0]
            if post:
                value = configure_visibility(vault, note_id, body.get("value"))
                service.reset()
            else:
                value = "never" if note_id in hidden_notes(vault) else "allowed"
            self.write_json({"value": value})
        elif route == "/api/ai/audit":
            if post and body == {"action": "clear"}:
                settings.save(vault, ai_proposals.AUDIT, [])
            elif post:
                raise VaultError("Invalid AI audit action.")
            self.write_json({"events": settings.load(vault, ai_proposals.AUDIT, [])})
        else:
            raise VaultError("AI action not found.", 404)

    def handle_public_page(self, slug: str, *, unlock: bool) -> None:
        snapshot = fetch_public_snapshot(self.server.vault, slug)
        if snapshot is None:
            body = b"<!doctype html><meta charset='utf-8'><title>Not found</title><p>This public note does not exist or was unpublished.</p>"
            self.start_response(404, len(body), "text/html; charset=utf-8", csp=PUBLIC_CONTENT_POLICY)
            self.wfile.write(body)
            return
        pw_hash = snapshot["password_hash"]
        cookie_name = f"xotira_pub_{slug}"
        if unlock and self.command == "POST":
            raw = self.read_body(4096).decode("utf-8", errors="replace")
            form = parse_qs(raw)
            candidate = form.get("password", [""])[0]
            if verify_share_password(pw_hash, candidate):
                token = make_unlock_cookie(self.server.public_cookie_secret, slug, pw_hash)
                headers = [
                    ("Set-Cookie", f"{cookie_name}={token}; HttpOnly; SameSite=Strict; Path=/p/{slug}"),
                    ("Location", f"/p/{slug}"),
                ]
                self.start_response(303, 0, "text/plain; charset=utf-8", csp=PUBLIC_CONTENT_POLICY, extra_headers=headers)
                return
            page = render_public_page_html(snapshot, locked=True, error_msg="Incorrect password. Try again.")
            self.start_response(403, len(page), "text/html; charset=utf-8", csp=PUBLIC_CONTENT_POLICY)
            self.wfile.write(page)
            return
        if self.command != "GET":
            raise VaultError("Method not allowed.", 405)
        locked = False
        if pw_hash:
            cookies = SimpleCookie()
            cookies.load(self.headers.get("Cookie", ""))
            cookie_token = cookies[cookie_name].value if cookie_name in cookies else ""
            locked = not verify_unlock_cookie(self.server.public_cookie_secret, slug, pw_hash, cookie_token)
        page = render_public_page_html(snapshot, locked=locked)
        self.start_response(200, len(page), "text/html; charset=utf-8", csp=PUBLIC_CONTENT_POLICY)
        self.wfile.write(page)

    def propose_agent_write(self, item: dict[str, Any]) -> None:
        if not self.server.agent_proposals_enabled:
            raise VaultError("The agent has read-only access.", 403)
        proposals = self.server.current_proposals()
        if len(proposals) >= 20:
            raise VaultError("The limit for pending proposals has been reached.", 429)
        proposal_id = secrets.token_hex(16)
        proposals[proposal_id] = {**item, "expires": time.monotonic() + 600}
        self.write_json({"proposalId": proposal_id, "status": "pendingApproval"}, 202)

    def handle_agent_api(self, route: str, query: dict[str, list[str]], body: dict[str, Any]) -> None:
        vault = self.server.vault
        post = self.command == "POST"
        if route == "/api/agent/health" and not post:
            self.write_json({"ok": True, "version": "6.0", **vault.status(), **brain_stats(vault)})
            return
        if route == "/api/agent/stats" and not post:
            self.write_json(brain_stats(vault))
            return
        if route == "/api/agent/graph" and not post:
            self.write_json(export_brain_json(vault))
            return
        if route == "/api/agent/search" and not post:
            q = query.get("q", [""])[0][:400]
            tag = query.get("tag", [""])[0][:60]
            limit = int(query.get("limit", ["12"])[0]) if query.get("limit", ["12"])[0].isdigit() else 12
            include_body = query.get("body", ["0"])[0] == "1"
            self.write_json(search_brain(vault, q, tag=tag, limit=limit, include_body=include_body))
            return
        if route == "/api/agent/context" and not post:
            q = query.get("q", [""])[0][:400]
            max_chars = int(query.get("max_chars", ["12000"])[0]) if query.get("max_chars", ["12000"])[0].isdigit() else 12000
            limit = int(query.get("limit", ["6"])[0]) if query.get("limit", ["6"])[0].isdigit() else 6
            hops = int(query.get("hops", ["1"])[0]) if query.get("hops", ["1"])[0].isdigit() else 1
            self.write_json(build_context_pack(vault, q, max_chars=max_chars, limit=limit, hops=hops))
            return
        browser_session = secrets.compare_digest(self.headers.get("Authorization", "").encode("latin-1"),
                                                f"Bearer {self.server.token}".encode("ascii"))
        if route == "/api/agent/notes":
            if not post:
                protected_ids = hidden_notes(vault)
                active = [n for n in vault.notes.values() if not n.trashed and not n.storage_only and n.id not in protected_ids]
                self.write_json({
                    "notes": [
                        {"id": n.id, "title": n.title, "tags": n.tags, "path": n.path, "source": n.source, "updated": n.updated}
                        for n in sorted(active, key=lambda x: x.updated, reverse=True)
                    ]
                })
                return
            if not browser_session:
                if not isinstance(body.get("title"), str):
                    raise VaultError("Enter a note title.")
                self.propose_agent_write({"action": "create", "title": clean_title(body["title"]),
                                          "text": note_body(body.get("body", "")),
                                          "tags": note_tags(body.get("tags", []))})
                return
            ids = vault.create_notes([{
                "title": body.get("title", ""),
                "body": body.get("body", ""),
                "tags": body.get("tags", []),
            }])
            self.write_json(vault.get_note(ids[0]), 201)
            return
        match = AGENT_NOTE_PATH.fullmatch(route)
        if match:
            note_id, sub = match.groups()
            if note_id in hidden_notes(vault):
                raise VaultError("This note is excluded from the AI Brain API.", 403)
            if sub == "append" and post:
                if not browser_session:
                    note = vault.get_note(note_id, resolve=False)
                    text = note_body(body.get("text", "")).strip()
                    if not text or note["trashed"]:
                        raise VaultError("Provide text and an active note.")
                    self.propose_agent_write({"action": "append", "noteId": note_id,
                                              "revision": note["revision"], "title": note["title"], "text": text})
                    return
                self.write_json(vault.append_to_note(note_id, body.get("text", "")))
                return
            if sub is None and not post:
                self.write_json(vault.get_note(note_id))
                return
        raise VaultError("AI Brain action not found.", 404)


def default_vault() -> Path:
    home = Path.home()
    if sys.platform == "darwin":
        folder = home / "Library/Application Support/Xotira"
    elif sys.platform == "win32":
        folder = Path(os.environ.get("APPDATA") or home / "AppData/Roaming") / "Xotira"
    else:
        folder = home / ".local/share/Xotira"
    return folder / "Xotira.xotira"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", type=Path, default=default_vault(), help="Vault or backup file path")
    parser.add_argument("--backup-dir", type=Path, help="Existing folder for automatic backups")
    parser.add_argument("--port", type=int, default=0, help="Local port (for example, 4720 for an AI agent)")
    parser.add_argument("--restore-zip", type=Path, help="Restore a portable ZIP to a new vault")
    parser.add_argument("--ai-dev", action="store_true", help="Enable offline AI developer mode")
    launch_mode = parser.add_mutually_exclusive_group()
    launch_mode.add_argument("--no-browser", action="store_true", help="Run headless and print the local URL")
    launch_mode.add_argument("--browser", action="store_true", help="Explicitly open the workspace in the default browser")
    args = parser.parse_args()
    path = args.vault.expanduser().resolve()
    backup_dir = args.backup_dir.expanduser().resolve() if args.backup_dir else None
    os.umask(0o077)
    vault = Vault(path)
    updater = UpdateManager(default_vault().parent / "updates",
                            os.environ.get("XOTIRA_GITHUB_REPO") or build_config.GITHUB_REPO, VERSION)
    if not args.no_browser and not args.restore_zip and updater.launch_pending(sys.argv[1:]):
        return
    try:
        if args.restore_zip:
            if args.vault == parser.get_default("vault"):
                raise VaultError("Provide a new --vault file path with --restore-zip.")
            with vault.process_lock():
                restore_snapshot(args.restore_zip.expanduser().resolve(), path)
            print(f"Restored: {path}", flush=True)
            return
        with vault.process_lock(), Server(vault, backup_dir, port=args.port, ai_developer=args.ai_dev) as server:
            url = f"{server.origin}/#{server.token}"
            print(f"Memory map is running: {url}\nClose this window to quit.", flush=True)
            print(f"AI Brain API: {server.origin}/api/agent/health", flush=True)
            print(f"Vault: {path}", flush=True)
            try:
                if args.no_browser or args.browser:
                    if args.browser:
                        webbrowser.open(url)
                    server.serve_forever(poll_interval=0.5)
                else:
                    # Native UI owns the main thread. Closing its window stops the local service.
                    from native_shell import NativeWindowError, run_window
                    thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.5}, daemon=True)
                    thread.start()
                    try:
                        run_window(url, prepare_close=server.prepare_native_close)
                    except NativeWindowError as error:
                        raise VaultError(str(error)) from error
                    finally:
                        server.shutdown()
                        thread.join(timeout=5)
            except KeyboardInterrupt:
                pass
            finally:
                with server.mutex:
                    vault.lock()
    except (VaultError, OSError) as error:
        raise SystemExit(f"Xotira: {error}") from error


if __name__ == "__main__":
    if sys.argv[1:] == ["--snippet-worker"]:
        snippet_worker()
    else:
        main()
