"""Calendar data, roadmap tasks, and local access boundaries."""

from __future__ import annotations

from contextlib import closing
import http.client
import json
import os
from pathlib import Path
import stat
import tempfile
import threading
import time
import unittest
from typing import Any

from app import Server
from vault import LOCK_SECONDS, Vault, VaultError

PASSWORD = "offline-calendar-test-password"
WHEN = "2028-02-29T08:45:00Z"


class PlanningAndAccessTests(unittest.TestCase):
    def setUp(self) -> None:
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        self.path = Path(root.name) / "test.xotira"
        self.vault = Vault(self.path)
        self.vault.unlock(PASSWORD, create=True)

    def serve(self) -> Server:
        server = Server(self.vault, None)
        threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def request(
        self, server: Server, route: str, body: dict[str, Any] | None = None, *,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, Any]]:
        if headers is None:
            headers = {"Authorization": f"Bearer {server.token}", "Origin": server.origin}
        if body is not None:
            headers = {**headers, "Content-Type": "application/json"}
        with closing(http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)) as connection:
            connection.request("GET" if body is None else "POST", route,
                               None if body is None else json.dumps(body), headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())

    def test_event_is_atomic_and_reminder_stays_encrypted_through_backup(self) -> None:
        with self.assertRaises(VaultError):
            self.vault.create_notes([{"title": "Before invalid"}, {"title": "Invalid", "eventDate": "2027-02-29"}])
        self.assertNotIn("Before invalid", [note.title for note in self.vault.notes.values()])

        note_id, = self.vault.create_notes([{"title": "Review", "eventDate": "2028-02-29"}])
        note = self.vault.get_note(note_id)
        self.assertEqual(note["entity"]["fields"], {"type": "event", "due": "2028-02-29"})
        self.assertEqual(self.vault.set_reminder(note_id, WHEN, ""), {"at": WHEN})
        with self.assertRaises(VaultError) as conflict:
            self.vault.set_reminder(note_id, "", "")
        self.assertEqual(conflict.exception.status, 409)
        self.assertNotIn(WHEN.encode(), self.path.read_bytes())
        # POSIX mode bits do not represent the inherited Windows user-directory ACL.
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

        target = self.path.with_name("backup.xotira")
        self.vault.backup(target)
        restored = Vault(target)
        restored.unlock(PASSWORD, create=False)
        self.assertEqual(restored.reminders(), {note_id: WHEN})
        self.vault.update_note(note_id, {"revision": note["revision"], "trashed": True})
        self.assertEqual(self.vault.reminders(), {})
        self.vault.update_note(note_id, {"revision": self.vault.get_note(note_id)["revision"], "trashed": False})
        self.assertEqual(self.vault.reminders(), {note_id: WHEN})
        self.vault.update_note(note_id, {"revision": self.vault.get_note(note_id)["revision"], "trashed": True})
        self.vault.delete_trashed()
        with self.vault.connection() as database:
            self.assertIsNone(database.execute("SELECT value FROM metadata WHERE name = ?", ("reminder:" + note_id,)).fetchone())

    def test_task_phases_follow_level_two_headings_and_skip_code(self) -> None:
        body = "- [ ] First\r\n## Phase 1\r\n- [x] Done\r\n~~~md\r\n## Invisible\r\n- [ ] Skip\r\n~~~\r\n### Detail\r\n- [ ] Next"
        note_id, = self.vault.create_notes([{"title": "Course", "body": body}])
        tasks = [task for task in self.vault.tasks() if task["noteId"] == note_id]
        self.assertEqual([(task["text"], task["phase"], task["done"]) for task in tasks],
                         [("First", "", False), ("Done", "Phase 1", True), ("Next", "Phase 1", False)])
        self.assertLess(tasks[0]["phaseOffset"], tasks[1]["phaseOffset"])
        self.assertEqual(tasks[1]["phaseOffset"], tasks[2]["phaseOffset"])
        self.vault.toggle_task({**tasks[-1], "done": True})
        self.assertIn("- [x] Next", self.vault.get_note(note_id)["body"])

    def test_agent_opt_in_read_only_scopes_and_idle_revocation(self) -> None:
        server = self.serve()
        agent = {"X-Brain-Key": server.agent_key}
        self.assertEqual(self.request(server, "/api/agent/config")[1]["key"], "")
        self.assertEqual(self.request(server, "/api/agent/health", headers=agent)[0], 403)
        self.assertEqual(self.request(server, "/api/agent/config", {"enabled": True})[0], 200)
        before = self.vault.last_activity
        self.assertEqual(self.request(server, "/api/agent/health", headers=agent)[0], 200)
        self.assertEqual(self.vault.last_activity, before)
        self.assertEqual(self.request(server, "/api/agent/notes", {"title": "Proposal"}, headers=agent)[0], 403)
        self.assertEqual(self.request(server, "/api/notes", {"title": "Owner action"}, headers=agent)[0], 401)
        owner_cross_site = {"Authorization": f"Bearer {server.token}", "Sec-Fetch-Site": "cross-site"}
        self.assertEqual(self.request(server, "/api/reminders", headers=owner_cross_site)[0], 403)
        before = self.vault.last_activity
        self.assertEqual(self.request(server, "/api/reminders")[0], 200)
        self.assertEqual(self.vault.last_activity, before)
        self.vault.last_activity = time.monotonic() - LOCK_SECONDS - 1
        self.assertFalse(self.request(server, "/api/status")[1]["unlocked"])
        self.assertEqual(self.request(server, "/api/unlock", {"password": PASSWORD})[0], 200)
        self.assertEqual(self.request(server, "/api/agent/health", headers=agent)[0], 403)
        config = self.request(server, "/api/agent/config", {"enabled": True})[1]
        self.assertNotEqual(config["key"], agent["X-Brain-Key"])
        self.assertEqual(self.request(server, "/api/agent/health", headers=agent)[0], 401)
