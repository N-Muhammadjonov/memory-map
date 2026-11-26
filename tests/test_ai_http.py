import http.client
import io
import json
import sqlite3
from contextlib import closing
import tempfile
import threading
import unittest
from pathlib import Path
from zipfile import ZipFile

import ai_providers
from ai.context import configure_visibility
from app import Server
from vault import Vault


class AILoopbackTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.vault = Vault(self.root / "ai.xotira")
        self.vault.unlock("safe test fixture notes", create=True)
        self.server = Server(self.vault, None, ai_developer=True)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(thread.join, 3)
        self.addCleanup(self.server.shutdown)

    def request(self, path, body=None, *, auth=True):
        headers = {"Content-Type": "application/json", "Origin": self.server.origin}
        if auth:
            headers["Authorization"] = "Bearer " + self.server.token
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=8)
        try:
            connection.request("GET" if body is None else "POST", path,
                               body=None if body is None else json.dumps(body), headers=headers)
            response = connection.getresponse()
            data = response.read()
            mime = response.getheader("Content-Type", "")
            if mime.startswith("application/json"):
                data = json.loads(data)
            elif mime.startswith("application/x-ndjson"):
                data = [json.loads(line) for line in data.splitlines()]
            return response.status, data
        finally:
            connection.close()

    def mock(self):
        code, config = self.request("/api/ai/settings", {"enabled": True, "provider": "mock"})
        self.assertEqual(code, 200)
        self.assertTrue(config["connected"])

    def test_default_off_stream_review_and_one_time_approval(self):
        route = "/api/ai/preview"
        self.assertEqual(self.request(route, {"prompt": "test"}, auth=False)[0], 401)
        self.assertEqual(self.request(route, {"prompt": "test"})[1], {"errorCode": "not_connected"})
        self.mock()
        note_id = self.vault.create_notes([{"title": "Private fixture", "body": "Old text"}])[0]
        code, preview = self.request(route, {"noteId": note_id, "prompt": "[mock:propose-edit]"})
        self.assertEqual(code, 200)
        self.assertIn("Old text", preview["payload"])
        code, events = self.request("/api/ai/send", {"previewId": preview["previewId"]})
        self.assertEqual(code, 200)
        self.assertEqual(events[0]["type"], "started")
        self.assertEqual(events[-1]["type"], "done")
        proposal = next(item["proposal"] for item in events if item["type"] == "proposal")
        self.assertEqual(self.vault.notes[note_id].body, "Old text")
        self.assertEqual(self.request("/api/ai/send", {"previewId": preview["previewId"]})[0], 409)
        self.assertEqual(self.request("/api/ai/proposals", {"action": "approve", "ids": [proposal["id"]]})[0], 200)
        self.assertIn("Mock review", self.vault.notes[note_id].body)
        self.assertEqual(self.request("/api/ai/proposals", {"action": "undo", "ids": [proposal["id"]]})[0], 200)
        self.assertEqual(self.vault.notes[note_id].body, "Old text")

    def test_canary_private_data_not_exported_and_old_snapshot_opens(self):
        canary = "CANARY_12345"
        self.mock()
        secret = self.vault.create_notes([{"title": "Hidden", "body": canary + " [mock:propose-edit]"}])[0]
        public = self.vault.create_notes([{"title": "Public", "body": "Ordinary text"}])[0]
        self.vault.set_note_password(secret, "private note fixture")
        configure_visibility(self.vault, secret, "never")
        self.assertEqual(self.request("/api/ai/credentials", {"provider": "openai", "apiKey": "fixture_" + canary})[0], 200)
        self.assertNotIn(canary, str(self.request("/api/ai/settings")[1]))
        self.assertEqual(self.request("/api/ai/test", {"provider": "openai"})[1], {"ok": False})
        _, preview = self.request("/api/ai/preview", {"noteId": public, "action": "wizard", "prompt": "IELTS", "search": "Hidden"})
        self.assertNotIn(canary, preview["payload"])
        self.assertEqual(self.request("/api/ai/send", {"previewId": preview["previewId"]})[0], 200)
        self.assertNotIn(canary, json.dumps(self.request("/api/ai/audit")[1]))
        self.assertNotIn(canary, json.dumps(self.server.telemetry.payload({"consent": True})))
        code, page = self.request("/api/notes/" + public + "/share", {"enabled": True})
        self.assertEqual(code, 200)
        code, html = self.request("/p/" + page["slug"])
        self.assertEqual(code, 200)
        self.assertNotIn(canary.encode(), html)
        code, zip_data = self.request("/api/export/portable")
        self.assertEqual(code, 200)
        with ZipFile(io.BytesIO(zip_data)) as archive:
            for name in archive.namelist():
                self.assertNotIn(canary.encode(), archive.read(name))
            snapshot = next(name for name in archive.namelist() if name.endswith(".xotira"))
            copy = self.root / "copied.xotira"
            copy.write_bytes(archive.read(snapshot))
        with closing(sqlite3.connect(copy)) as database:
            self.assertEqual(database.execute("SELECT name FROM metadata WHERE name GLOB 'ai_*'").fetchall(), [])
        restored = Vault(copy)
        restored.unlock("safe test fixture notes", create=False)
        self.assertEqual(restored.notes[secret].body, canary + " [mock:propose-edit]")
        self.assertEqual(ai_providers.read(restored), {})

    def test_character_limits_and_opt_in_counts(self):
        self.mock()
        note = self.vault.create_notes([{"title": "Long", "body": ('Line with ""\n' * 6000)}])[0]
        self.request("/api/ai/settings", {"requestCap": 6500, "monthlyCap": 9000})
        _, preview = self.request("/api/ai/preview", {"noteId": note, "prompt": "Summarize"})
        self.assertLessEqual(preview["chars"], 6500)
        self.assertIn("current_trimmed", preview["cuts"])
        self.assertEqual(self.request("/api/ai/send", {"previewId": preview["previewId"]})[0], 200)
        self.assertNotIn("ai_counts", self.server.telemetry.payload({"consent": True}))
        self.request("/api/ai/settings", {"shareCounts": True})
        self.assertNotIn("ai_counts", self.server.telemetry.payload({"consent": False}))
        self.assertEqual(self.server.telemetry.payload({"consent": True})["ai_counts"], {"requests": 1, "approvals": 0})
        self.request("/api/ai/settings", {"monthlyCap": 500})
        self.assertEqual(self.request("/api/ai/preview", {"prompt": "More"})[1]["errorCode"], "monthly_limit")
