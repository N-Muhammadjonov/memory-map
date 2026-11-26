#!/usr/bin/env python3
"""Public host for Xotira pages. Run it on a server you control, behind HTTPS.

  python3 publish_server.py --data ./pages --key "<secret of 16+ characters>" --base-url https://pages.example.com

What it stores: only the finished HTML page of each note you publish (the same page your own Xotira renders).
It never receives your vault, passwords or other notes. Each page has an unguessable link /p/<token>.
Unpublishing or trashing the note in Xotira deletes the page here. Only the holder of the key can add or delete pages.
Pages without a password lock are served with scripts disabled; locked pages need one inline script to decrypt in the browser.
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
import re
import secrets
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TOKEN = re.compile(r"[A-Za-z0-9_-]{22}\Z")
MAX_PAGE = 12 * 1024 * 1024
MAX_PAGES = 5000
CSP_PLAIN = ("default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; "
             "form-action 'none'; frame-ancestors 'none'; object-src 'none'")
CSP_LOCKED = CSP_PLAIN.replace("script-src 'none'", "script-src 'unsafe-inline'")


class Handler(BaseHTTPRequestHandler):
    server_version = "XotiraPublish/1"

    def log_message(self, *args: object) -> None:  # tokens must not reach logs
        pass

    def send(self, status: int, body: bytes, kind: str, extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Robots-Tag", "noindex, nofollow")
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def reply(self, status: int, value: dict[str, object]) -> None:
        self.send(status, json.dumps(value).encode(), "application/json; charset=utf-8", {"Cache-Control": "no-store"})

    def authorized(self) -> bool:
        given = (self.headers.get("Authorization") or "").removeprefix("Bearer ")
        if hmac.compare_digest(given.encode(), self.server.key.encode()):  # type: ignore[attr-defined]
            return True
        time.sleep(0.5)  # slow down key guessing
        self.reply(401, {"error": "Unauthorized."})
        return False

    def path_for(self, token: str) -> Path | None:
        return self.server.root / f"{token}.html" if TOKEN.fullmatch(token) else None  # type: ignore[attr-defined]

    def api_token(self) -> str | None:
        parts = self.path.split("?")[0].strip("/").split("/")
        return parts[2] if len(parts) == 3 and parts[:2] == ["api", "pages"] else None

    def do_GET(self) -> None:
        if self.path == "/health":
            return self.reply(200, {"ok": True})
        parts = self.path.split("?")[0].strip("/").split("/")
        path = self.path_for(parts[1]) if len(parts) == 2 and parts[0] == "p" else None
        if path is None or not path.is_file():
            return self.send(404, b"Not found", "text/plain; charset=utf-8")
        locked = path.with_suffix(".lock").exists()
        self.send(200, path.read_bytes(), "text/html; charset=utf-8", {
            "Content-Security-Policy": CSP_LOCKED if locked else CSP_PLAIN, "X-Frame-Options": "DENY",
            "Cache-Control": "no-cache"})

    def read_page(self) -> tuple[str, bool] | None:
        try:
            size = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self.reply(411, {"error": "Length required."})
            return None
        if size > MAX_PAGE + 4096:
            self.reply(413, {"error": "Too large."})
            return None
        try:
            data = json.loads(self.rfile.read(size))
            page, locked = data["html"], data["locked"] is True
            if not isinstance(page, str) or len(page) > MAX_PAGE or not page.lstrip().lower().startswith("<!doctype html"):
                raise ValueError
            return page, locked
        except (ValueError, KeyError, TypeError):
            self.reply(400, {"error": "Invalid page."})
            return None

    def store(self, token: str, page: str, locked: bool) -> None:
        path = self.path_for(token)
        assert path is not None
        descriptor, name = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            file.write(page)
        if locked:
            path.with_suffix(".lock").touch()
        else:
            path.with_suffix(".lock").unlink(missing_ok=True)
        os.replace(name, path)

    def link(self, token: str) -> str:
        return f"{self.server.base_url}/p/{token}"  # type: ignore[attr-defined]

    def do_POST(self) -> None:
        if self.path != "/api/pages":
            return self.reply(404, {"error": "Not found."})
        if not self.authorized():
            return
        parsed = self.read_page()
        if parsed is None:
            return
        if len(list(self.server.root.glob("*.html"))) >= MAX_PAGES:  # type: ignore[attr-defined]
            return self.reply(507, {"error": "Page limit reached."})
        token = secrets.token_urlsafe(16)
        self.store(token, *parsed)
        self.reply(201, {"token": token, "url": self.link(token)})

    def do_PUT(self) -> None:
        token = self.api_token()
        path = self.path_for(token) if token else None
        if path is None:
            return self.reply(404, {"error": "Not found."})
        if not self.authorized():
            return
        if not path.is_file():
            return self.reply(404, {"error": "Not found."})
        parsed = self.read_page()
        if parsed is not None:
            self.store(token, *parsed)  # type: ignore[arg-type]
            self.reply(200, {"token": token, "url": self.link(token)})  # type: ignore[arg-type]

    def do_DELETE(self) -> None:
        token = self.api_token()
        path = self.path_for(token) if token else None
        if path is None:
            return self.reply(404, {"error": "Not found."})
        if not self.authorized():
            return
        if not path.is_file():
            return self.reply(404, {"error": "Not found."})
        path.unlink(missing_ok=True)
        path.with_suffix(".lock").unlink(missing_ok=True)
        self.reply(200, {"ok": True})


def make_server(host: str, port: int, data: Path, key: str, base_url: str = "") -> ThreadingHTTPServer:
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    server = ThreadingHTTPServer((host, port), Handler)
    server.root, server.key = data.resolve(), key  # type: ignore[attr-defined]
    server.base_url = (base_url or f"http://{host}:{server.server_port}").rstrip("/")  # type: ignore[attr-defined]
    return server


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--data", type=Path, default=Path("pages"))
    parser.add_argument("--key", default=os.environ.get("XOTIRA_PUBLISH_KEY", ""))
    parser.add_argument("--base-url", default="", help="public https address that visitors use")
    args = parser.parse_args()
    key = args.key or secrets.token_urlsafe(32)
    if len(key) < 16:
        parser.error("The publish key must be at least 16 characters.")
    server = make_server(args.host, args.port, args.data, key, args.base_url)
    print(f"Xotira publish server: {server.base_url}\nPublish key: {key}", flush=True)  # type: ignore[attr-defined]
    server.serve_forever()


if __name__ == "__main__":
    main()
