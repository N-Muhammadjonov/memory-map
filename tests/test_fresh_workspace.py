"""Exercise workflows from an empty vault through the local HTTP entry points."""

from __future__ import annotations

from contextlib import closing
import base64
import hashlib
from http.client import HTTPConnection
import io
import json
from pathlib import Path
import tempfile
import threading
from typing import Any
import unittest
from urllib.parse import urlencode
from zipfile import ZipFile

from app import Server

from account_fixture import fixture_account
from batch1_fixtures import png
from portable_archive import restore_snapshot
from vault import Vault

PASSWORD = "fresh-workspace-fixture-password"


class FreshWorkspaceTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.server = Server(Vault(self.root / "fresh.xotira"), None, account=fixture_account())
        worker = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        worker.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(worker.join, 3)
        self.addCleanup(self.server.shutdown)

    def request(self, path: str, body: dict[str, Any] | bytes | None = None, *,
                status: int = 200, token: bool = True, binary: bool = False) -> Any:
        headers = {"Origin": self.server.origin}
        if token:
            headers["Authorization"] = f"Bearer {self.server.token}"
        wire = body
        if isinstance(body, dict):
            headers["Content-Type"] = "application/json"
            wire = json.dumps(body).encode()
        elif isinstance(body, bytes):
            headers["Content-Type"] = "application/octet-stream"
        with closing(HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)) as connection:
            connection.request("GET" if body is None else "POST", path, wire, headers)
            response = connection.getresponse()
            self.assertEqual(response.status, status, path)
            data = response.read()
            return data if binary else json.loads(data)

    def test_first_note_and_new_files_survive_graph_trash_lock_and_restore(self) -> None:
        self.assertFalse(self.request("/api/status")["exists"])
        self.request("/api/graph", status=423)
        self.request("/api/create", {"password": PASSWORD})
        empty = self.request("/api/graph")
        self.assertEqual((empty["nodes"], empty["files"], empty["edges"]), ([], [], []))

        original = "#### Rehearsal 100%\n\n## Practice\n- [ ] Rehearse\n\n[[Reference]]"
        note, reference = self.request("/api/notes", {"notes": [
            {"title": "Week one", "body": original, "tags": ["Practice"]},
            {"title": "Reference", "body": "Review the presentation."},
        ]}, status=201)["ids"]
        note_path = f"/api/notes/{note}"
        event, = self.request("/api/notes", {"notes": [
            {"title": "Review day", "eventDate": "2028-02-29"},
        ]}, status=201)["ids"]
        self.assertEqual(self.request(f"/api/notes/{event}")["entity"]["fields"]["due"], "2028-02-29")
        reminder = "2028-02-29T09:00:00Z"
        self.request("/api/reminders", {"noteId": event, "at": reminder, "expected": ""})
        self.request(note_path + "/entity", {"revision": 0, "fields": {
            "type": "project", "relationships": [{"type": "cites", "target": reference}],
        }})
        task = self.request("/api/tasks")["tasks"][0]
        self.assertEqual(task["phase"], "Practice")
        self.request("/api/tasks", {**task, "done": True})
        self.assertIn("- [x] Rehearse", self.request(note_path)["body"])

        image = png(200, 200)
        photo = self.request(note_path + "/files?" + urlencode({"name": "Scene #1.png"}), image, status=201)
        text = self.request(note_path + "/files?" + urlencode({"name": "Sources.txt"}), b"Reference text", status=201)
        drawing = self.request(note_path + "/files?view=drawing", {
            "revision": self.request(note_path)["revision"], "offset": 0,
            "image": base64.b64encode(image).decode(),
            "strokes": [{"color": "#334455", "size": 4, "points": [[20, 50], [80, 110]]}],
        }, status=201)
        self.assertIn("attachment:", drawing["note"]["body"])
        mind = self.request("/api/mind-maps", {"title": "Practice map", "noteId": note}, status=201)
        mind_path = f"{note_path}/files/{mind['id']}"
        raw = self.request(mind_path, binary=True)
        layout = json.loads(raw)
        branch = "6" * 32
        layout["topics"].append({"id": branch, "parent": layout["root"], "side": "left", "title": "Rehearsal"})
        changed = self.request(mind_path + "?view=mind-map", {
            "checksum": hashlib.sha256(raw).hexdigest(), "map": layout,
        })
        opened = self.request(mind_path + "?view=mind-map", {"checksum": changed["checksum"], "openTopic": branch})
        self.assertEqual(self.request(f"/api/notes/{opened['noteId']}")["title"], "Rehearsal")
        graph = self.request("/api/graph")
        self.assertIn([note, photo["id"]], graph["edges"])
        current = self.request("/api/graph?" + urlencode({"q": "week one"}))
        self.assertIn(note, current["hits"])
        self.request("/api/graph/position", {"id": note, "position": [2.5, -4, 1]})
        self.assertEqual(self.request("/api/graph")["positions"][note], [2.5, -4, 1])

        self.request("/api/trash", {"action": "move", "file": {"noteId": note, "id": photo["id"]}})
        self.assertNotIn(photo["id"], {item["id"] for item in self.request(note_path)["attachments"]})
        self.assertIn(photo["id"], {item["id"] for item in self.request("/api/graph?trash=1")["files"]})
        self.request("/api/trash", {"action": "restore", "file": {"noteId": note, "id": photo["id"]}})
        self.assertEqual(self.request(f"{note_path}/files/{photo['id']}", binary=True), image)

        snippet = {"language": "python", "source": 'print("Ready")'}
        if self.request("/api/snippets/check", snippet)["runnable"]:
            code = self.request("/api/snippets/run", snippet)
            self.assertEqual(code["output"].strip(), "Ready")
        else:
            self.request("/api/snippets/run", snippet, status=400)
        self.request("/api/lock", {})
        self.request(note_path, status=423)
        self.request("/api/unlock", {"password": PASSWORD})
        self.assertEqual(self.request("/api/reminders")["reminders"][event], reminder)
        self.assertIn("Rehearsal 100%", self.request(note_path)["body"])
        self.assertEqual(self.request(f"{note_path}/files/{text['id']}", binary=True), b"Reference text")

        backup = self.root / "portable.zip"
        backup.write_bytes(self.request("/api/export/portable", binary=True))
        restored = Vault(self.root / "restored.xotira")
        restore_snapshot(backup, restored.path)
        restored.unlock(PASSWORD, create=False)
        self.assertEqual(restored.attachment(note, photo["id"])[1], image)
        self.assertEqual(restored.reminders()[event], reminder)
        self.assertIn("- [x] Rehearse", restored.get_note(note)["body"])
        restored.lock()

    def test_repeated_file_and_template_titles_work_with_trash_aliases_and_import(self) -> None:
        self.request("/api/create", {"password": PASSWORD})
        title = "Plan"
        first, = self.request("/api/notes", {"notes": [{"title": title}]}, status=201)["ids"]
        path = f"/api/notes/{first}"
        self.request(path, {"revision": 1, "title": "Updated Plan", "body": "", "tags": []})
        self.request(path, {"revision": 2, "trashed": True})
        automatic = {"title": title, "useAvailableTitle": True}
        second, third = self.request("/api/notes", {"notes": [automatic, automatic]}, status=201)["ids"]
        self.assertEqual(self.request(f"/api/notes/{second}")["title"], "Plan")
        self.assertEqual(self.request(f"/api/notes/{third}")["title"], "Plan (2)")
        reserved, = self.request("/api/notes", {"notes": [
            {"title": "[New] #draft", "useAvailableTitle": True},
        ]}, status=201)["ids"]
        self.assertEqual(self.request(f"/api/notes/{reserved}")["title"], "（New） ＃draft")
        self.request("/api/notes", {"notes": [{"title": title}]}, status=409)
        self.request(path, {"revision": self.request(path)["revision"], "trashed": False})
        self.assertEqual(self.request(path)["title"], "Updated Plan")
        self.assertNotIn("Plan", self.request(path)["aliases"])

        buffer = io.BytesIO()
        with ZipFile(buffer, "w") as archive:
            archive.writestr("Plans/Agenda.md", "# Agenda\n\n[Details](Details.md#Summary)")
            archive.writestr("Plans/Details.md", "## Summary\n\nA new workspace")
        self.request("/api/import/zip?source=Workspace&format=markdown", buffer.getvalue(), status=201)
        imported = self.request("/api/graph")["nodes"]
        agenda = next(note for note in imported if note["path"] == "Plans/Agenda.md")
        details = next(note for note in imported if note["path"] == "Plans/Details.md")
        self.assertIn(details["id"], self.request(f"/api/notes/{agenda['id']}")["links"].values())
