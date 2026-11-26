"""HTTP coverage for the drawing revisions and portable image round-trip."""

from __future__ import annotations

import base64
import hashlib
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Any

from app import Server
from batch1_fixtures import PASSWORD, png, seed
from portable_archive import restore_snapshot
from vault import Vault


class Batch1WorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        folder = tempfile.TemporaryDirectory()
        cls.addClassCleanup(folder.cleanup)
        cls.root = Path(folder.name)
        cls.vault = Vault(cls.root / "test.xotira")
        cls.vault.unlock(PASSWORD, create=True)
        cls.ids = seed(cls.vault)
        cls.server = Server(cls.vault, None)
        cls.worker = threading.Thread(target=cls.server.serve_forever,
                                      kwargs={"poll_interval": 0.02}, daemon=True)
        cls.worker.start()
        cls.addClassCleanup(cls.server.server_close)
        cls.addClassCleanup(cls.worker.join, 3)
        cls.addClassCleanup(cls.server.shutdown)

    def request(self, path: str, body: dict[str, Any] | None = None,
                *, authenticate: bool = True) -> tuple[int, bytes]:
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        headers = {"Origin": self.server.origin, "Content-Type": "application/json"}
        if authenticate:
            headers["Authorization"] = "Bearer " + self.server.token
        try:
            connection.request("GET" if body is None else "POST", path,
                               body=None if body is None else json.dumps(body), headers=headers)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def test_drawing_update_conflict_and_exact_legacy_delete(self) -> None:
        owner = self.ids["drawing"]
        unrelated = self.ids["first"]
        native_route = f"/api/notes/{owner}/files/{self.ids['native']}"
        legacy_route = f"/api/notes/{owner}/files/{self.ids['legacy']}"
        before = self.vault.get_note(unrelated)["body"]
        code, previous = self.request(native_route + "?view=drawing")
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(previous)["revision"], 1)
        self.assertEqual(self.request(native_route + "?view=drawing", authenticate=False)[0], 401)
        new_png = png(1200, 720, 25)
        sample = {"image": base64.b64encode(new_png).decode(), "revision": 1, "keepBase": False,
                  "strokes": [{"color": "#123456", "size": 1, "points": [[30, 30]]},
                              {"color": "#234567", "size": 20, "points": [[1199, 719]]}]}
        self.assertEqual(self.request(native_route + "?view=drawing", sample)[0], 200)
        self.assertEqual(self.request(native_route), (200, new_png))
        self.assertEqual(self.request(native_route + "?view=drawing", sample)[0], 409)
        self.assertEqual(self.request(native_route), (200, new_png))
        self.assertEqual(json.loads(self.request(native_route + "?view=drawing")[1])["strokes"], sample["strokes"])
        _, legacy = self.request(legacy_route + "?view=drawing")
        self.assertEqual(json.loads(legacy)["revision"], 0)
        self.assertTrue(json.loads(legacy)["base"])
        self.assertEqual(self.request(legacy_route + "?view=drawing", {**sample, "revision": 0, "keepBase": True})[0], 200)
        self.assertEqual(json.loads(self.request(legacy_route + "?view=drawing")[1])["base"], json.loads(legacy)["base"])
        note = self.vault.get_note(owner)
        literal = f"```text\n![Code example](attachment:{self.ids['legacy']})\n```"
        edited = self.vault.update_note(owner, {"title": note["title"], "tags": note["tags"],
            "revision": note["revision"], "body": note["body"] + "\n\n" + literal})
        revision = edited["revision"]
        self.assertEqual(self.request(legacy_route + "?view=drawing", {"delete": True, "revision": revision - 1})[0], 409)
        self.assertEqual(self.request(legacy_route + "?view=drawing", {"delete": True, "revision": revision})[0], 200)
        self.assertEqual(self.request(legacy_route)[0], 404)
        self.assertNotIn("![Legacy layout]", self.vault.get_note(owner)["body"])
        self.assertIn(literal, self.vault.get_note(owner)["body"])
        self.assertIn("Before drawing\n\n", self.vault.get_note(owner)["body"])
        self.assertIn("After drawing", self.vault.get_note(owner)["body"])
        self.assertEqual(self.vault.get_note(unrelated)["body"], before)
        self.assertEqual(self.request(native_route), (200, new_png))

    def test_portable_restore_preserves_note_attachment_and_drawing_state(self) -> None:
        owner, drawing = self.ids["first"], self.ids["drawing"]
        existing = self.vault.get_note(owner)
        saved = dict(title=existing["title"], tags=[], revision=existing["revision"],
                     body=f"Before 🧭\n\n{existing['body']}\n\nAfter")
        self.assertEqual(self.request(f"/api/notes/{owner}", saved)[0], 200)
        observed = self.vault.get_note(owner)["body"]
        reference = self.vault.attachment(owner, self.ids["cover"])[1]
        original = self.vault.drawing(drawing, self.ids["native"])
        code, portable = self.request("/api/export/portable")
        self.assertEqual(code, 200)
        zip_file = self.root / "portable.zip"
        zip_file.write_bytes(portable)
        restored = Vault(self.root / "restored.xotira")
        restore_snapshot(zip_file, restored.path)
        restored.unlock(PASSWORD, create=False)
        self.assertEqual(restored.get_note(owner)["body"], observed)
        self.assertEqual(hashlib.sha256(restored.attachment(owner, self.ids["cover"])[1]).digest(),
                         hashlib.sha256(reference).digest())
        self.assertEqual(restored.drawing(drawing, self.ids["native"]), original)
        restored.lock()
