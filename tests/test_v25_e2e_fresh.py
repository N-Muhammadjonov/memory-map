"""From-scratch (0 dan) end-to-end HTTP pipeline test for Xotira v25."""

from __future__ import annotations

import base64
import io
import json
import sys
import tempfile
import unittest
import zipfile
from email.parser import BytesParser
from pathlib import Path
from threading import RLock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app
from telemetry import Telemetry
from vault import Vault


class _MockSocket:
    def __init__(self, raw_request: bytes) -> None:
        self._rfile = io.BytesIO(raw_request)
        self._wfile = io.BytesIO()

    def settimeout(self, _timeout: float) -> None:
        pass

    def makefile(self, mode: str, _bufsize: int = -1):
        return self._rfile if "r" in mode else self._wfile

    def sendall(self, data: bytes) -> None:
        self._wfile.write(data)

    def raw_response(self) -> bytes:
        return self._wfile.getvalue()


class _FakeServer:
    restore_backup_status = app.Server.restore_backup_status
    record_backup = app.Server.record_backup

    def __init__(self, vault: Vault, port: int = 4725) -> None:
        self.vault = vault
        self.server_port = port
        self.host = f"127.0.0.1:{port}"
        self.origin = f"http://{self.host}"
        self.token = "A" * 43
        self.public_cookie_secret = "pub-secret-test-key"
        self.agent_key = "agent-secret-test-key"
        self.agent_enabled = False
        self.agent_proposals_enabled = False
        self.agent_proposals = {}
        self.mutex = RLock()
        self.backup_dir = None
        self.backup_error = ""
        self.last_backup = ""
        self.backup_changes = 0
        self.telemetry = Telemetry(vault, "")  # statistics are off in this harness

    def close_agent_access(self) -> None:
        self.agent_enabled = False
        self.agent_proposals_enabled = False
        self.agent_proposals.clear()

    def session_status(self) -> dict[str, bool]:
        status = self.vault.status()
        if not status["unlocked"] and self.agent_enabled:
            self.close_agent_access()
        return {**status, "authenticated": True}


def http_call(
    server: _FakeServer,
    method: str,
    path: str,
    *,
    body: bytes = b"",
    headers: dict[str, str] | None = None,
    host: str | None = None,
    origin: str | None = None,
    auth: bool = False,
) -> tuple[int, dict[str, str], bytes]:
    hdrs = {"Host": host or server.host}
    if auth:
        hdrs["Authorization"] = f"Bearer {server.token}"
    if origin is not None:
        hdrs["Origin"] = origin
    elif method == "POST":
        hdrs["Origin"] = server.origin
    if body or method == "POST":
        hdrs.setdefault("Content-Length", str(len(body)))
    if headers:
        hdrs.update(headers)
    head = f"{method} {path} HTTP/1.1\r\n" + "".join(f"{k}: {v}\r\n" for k, v in hdrs.items()) + "\r\n"
    sock = _MockSocket(head.encode("utf-8") + body)
    app.Handler(sock, ("127.0.0.1", 55000), server)
    raw = sock.raw_response()
    header_bytes, _, resp_body = raw.partition(b"\r\n\r\n")
    status_line, _, rest = header_bytes.partition(b"\r\n")
    status_code = int(status_line.split()[1])
    parsed = BytesParser().parsebytes(rest)
    resp_headers = {k.lower(): v for k, v in parsed.items()}
    return status_code, resp_headers, resp_body


class TestFreshVaultEndToEnd(unittest.TestCase):
    def test_zero_to_full_workflow(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault_a = Vault(Path(tmp) / "fresh_account_a.xotira")
            srv_a = _FakeServer(vault_a, port=4725)

            # 1. Static assets & CSP headers
            code, hdrs, html = http_call(srv_a, "GET", "/")
            self.assertEqual(code, 200)
            self.assertIn("manifest-src 'self'", hdrs["content-security-policy"])
            self.assertIn(b"manifest.webmanifest", html)

            code, hdrs, manifest_raw = http_call(srv_a, "GET", "/manifest.webmanifest")
            self.assertEqual(code, 200)
            manifest = json.loads(manifest_raw.decode("utf-8"))
            self.assertIn("Memory map", manifest["name"])

            for asset in ["/i18n.js", "/home.js", "/study-mode.js", "/database-view.js", "/notion-editor.js", "/note-renderers.js", "/app.js", "/styles.css"]:
                code, _, _ = http_call(srv_a, "GET", asset)
                self.assertEqual(code, 200, f"Static asset missing: {asset}")

            # 2. Brand-new vault status (exists=False) -> create via localhost Origin
            code, _, body = http_call(srv_a, "GET", "/api/status", auth=True)
            self.assertEqual(code, 200)
            self.assertEqual(json.loads(body)["exists"], False)

            code, _, _ = http_call(
                srv_a,
                "POST",
                "/api/create",
                body=json.dumps({"password": "Fresh-Password-2026!"}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                host="localhost:4725",
                origin="http://localhost:4725",
                auth=True,
            )
            self.assertEqual(code, 200)

            # 3. Create note with Mermaid sequenceDiagram + flashcards + task
            note_md = (
                "# Architecture RFC\n\n"
                "AES-GCM :: Authenticated encryption\n\n"
                "- [ ] Review security model\n\n"
                "```mermaid\nsequenceDiagram\nClient->>Server: Request\nServer-->>Client: Encrypted OK\n```"
            )
            code, _, created = http_call(
                srv_a,
                "POST",
                "/api/notes",
                body=json.dumps({"notes": [{"title": "RFC Zero", "body": note_md, "tags": ["Engineering"]}]}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                auth=True,
            )
            self.assertEqual(code, 201)
            note_id = json.loads(created)["ids"][0]

            # 4. BibTeX & Web Clipper endpoints
            bib = "@article{vaswani2017, title={Attention Is All You Need}, author={Vaswani, Ashish}, year={2017}}"
            code, _, bib_res = http_call(
                srv_a,
                "POST",
                "/api/tools/bibtex",
                body=json.dumps({"bibtex": bib}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                auth=True,
            )
            self.assertEqual(code, 201)
            self.assertIn("Attention Is All You Need", json.loads(bib_res)["title"])

            code, _, clip_res = http_call(
                srv_a,
                "POST",
                "/api/clip",
                body=json.dumps({"title": "Clip Sample", "url": "https://example.org", "quote": "Key quote", "tags": ["WebClip"]}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                auth=True,
            )
            self.assertEqual(code, 201)
            self.assertEqual(json.loads(clip_res)["title"], "Clip Sample")

            # 5. DOCX & EPUB 3 export
            code, _, docx_bytes = http_call(srv_a, "GET", f"/api/notes/{note_id}/export?format=docx", auth=True)
            self.assertEqual(code, 200)
            with zipfile.ZipFile(io.BytesIO(docx_bytes)) as zf:
                self.assertIn("word/document.xml", zf.namelist())

            code, _, epub_bytes = http_call(srv_a, "GET", f"/api/notes/{note_id}/export?format=epub", auth=True)
            self.assertEqual(code, 200)
            with zipfile.ZipFile(io.BytesIO(epub_bytes)) as zf:
                self.assertEqual(zf.read("mimetype"), b"application/epub+zip")

            # 6. Isolated single-note public link + password unlock + static HTML + static site ZIP
            code, _, share_res = http_call(
                srv_a,
                "POST",
                f"/api/notes/{note_id}/share",
                body=json.dumps({"enabled": True, "theme": "gitbook", "slug": "rfc-zero", "password": "secret-pass"}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                auth=True,
            )
            self.assertEqual(code, 200)
            self.assertTrue(json.loads(share_res)["enabled"])

            code, _, pub_locked = http_call(srv_a, "GET", "/p/rfc-zero")
            self.assertEqual(code, 200)
            self.assertIn(b"protected with a password", pub_locked)
            self.assertNotIn(b"Authenticated encryption", pub_locked)

            code, hdrs, _ = http_call(
                srv_a,
                "POST",
                "/p/rfc-zero/unlock",
                body=b"password=secret-pass",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                host="localhost:4725",
                origin="http://localhost:4725",
            )
            self.assertEqual(code, 303)
            self.assertIn("xotira_pub_rfc-zero=", hdrs.get("set-cookie", ""))

            code, _, static_html = http_call(
                srv_a,
                "POST",
                f"/api/notes/{note_id}/share?export=html",
                body=json.dumps({"password": "static-pw"}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                auth=True,
            )
            self.assertEqual(code, 200)
            self.assertIn(b"AES-GCM", static_html)

            code, _, site_zip = http_call(srv_a, "GET", "/api/shares/static-bundle", auth=True)
            self.assertEqual(code, 200)
            with zipfile.ZipFile(io.BytesIO(site_zip)) as zf:
                self.assertIn("404.html", zf.namelist())
                self.assertIn("_headers", zf.namelist())
                self.assertIn("p/rfc-zero/index.html", zf.namelist())

            # 7. Semantic search
            code, _, sem_res = http_call(srv_a, "GET", "/api/search?mode=semantic&q=encryption+attention", auth=True)
            self.assertEqual(code, 200)
            self.assertGreaterEqual(len(json.loads(sem_res)["results"]), 1)

            # 8. Encrypted Account-to-Account ZIP transfer with non-ASCII Uzbek UTF-8 passphrase!
            uz_pass = "O‘zbekiston-Maxfiy-Parol-2026!"
            code, _, transfer_zip = http_call(
                srv_a,
                "POST",
                "/api/transfer/export",
                body=json.dumps({"passphrase": uz_pass}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                auth=True,
            )
            self.assertEqual(code, 200)

            vault_b = Vault(Path(tmp) / "fresh_account_b.xotira")
            srv_b = _FakeServer(vault_b, port=4726)
            code, _, _ = http_call(
                srv_b,
                "POST",
                "/api/create",
                body=json.dumps({"password": "Account-B-Password-2026!"}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                auth=True,
            )
            self.assertEqual(code, 200)

            pass_b64 = base64.b64encode(uz_pass.encode("utf-8")).decode("ascii")
            code, _, import_res = http_call(
                srv_b,
                "POST",
                "/api/transfer/import?conflict=rename",
                body=transfer_zip,
                headers={
                    "Content-Type": "application/octet-stream",
                    "X-Transfer-Passphrase-B64": pass_b64,
                },
                auth=True,
            )
            self.assertEqual(code, 201)
            self.assertEqual(json.loads(import_res)["notes"], 3)

            # 9. Lock vault
            code, _, _ = http_call(srv_a, "POST", "/api/lock", body=b"{}", headers={"Content-Type": "application/json"}, auth=True)
            self.assertEqual(code, 200)
            code, _, st = http_call(srv_a, "GET", "/api/status", auth=True)
            self.assertFalse(json.loads(st)["unlocked"])

            vault_a.lock()
            vault_b.lock()


if __name__ == "__main__":
    unittest.main()
