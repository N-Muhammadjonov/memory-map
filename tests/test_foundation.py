"""Regression tests for migration, backups, search, tasks and approved writes."""

from __future__ import annotations

import http.client
import io
import json
import sqlite3
from contextlib import closing
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from zipfile import ZipFile

from agent_api import build_context_pack, search_brain
from app import Server
from account_fixture import fixture_account
from brain_sdk import XotiraBrain
from portable_archive import SNAPSHOT, restore_snapshot
from vault import Vault, VaultError

PASSWORD = "structure-test-password"


class FoundationTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.vault = Vault(self.root / "test.xotira")
        self.vault.unlock(PASSWORD, create=True)
        self.first, self.second, self.third = self.vault.create_notes([
            {"title": "Experiments", "body": "## Notes\nThe unique reference is quaternion.\r\n- [ ] Verify."},
            {"title": "Research summary", "body": "Some relevant background."},
            {"title": "Archive", "body": "Additional reading."},
        ])

    def serve(self) -> Server:
        server = Server(self.vault, None, account=fixture_account())
        threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.03}, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def request(self, server: Server, path: str, body: dict | bytes | None = None, *,
                agent: bool = False) -> tuple[int, bytes]:
        headers = ({"X-Brain-Key": server.agent_key} if agent else {
            "Authorization": f"Bearer {server.token}", "Origin": server.origin,
        })
        if isinstance(body, dict):
            body = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        elif isinstance(body, bytes):
            headers["Content-Type"] = "application/octet-stream"
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        try:
            connection.request("GET" if body is None else "POST", path, body, headers)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def test_structure_migration_backup_and_wrong_password(self) -> None:
        attachment = self.vault.store_attachment(self.first, "untouched.txt", b"Original file bytes")["id"]
        self.vault.move_graph_node(self.first, [1, 2, 3])
        self.vault.lock()
        with self.vault.connection() as db, db:
            for name in ("entity_fields", "entity_history", "note_history", "legacy_entity_fields"):
                db.execute(f"DROP TABLE {name}")
        with self.assertRaises(VaultError):
            self.vault.unlock("wrong", create=False)
        self.assertEqual(list(self.root.glob("*.pre-structure-*")), [])
        self.vault.next_unlock = 0
        self.vault.unlock(PASSWORD, create=False)
        snapshots = list(self.root.glob("*.pre-structure-*"))
        self.assertEqual(len(snapshots), 1)
        with closing(sqlite3.connect(snapshots[0])) as db:
            self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='entity_fields'").fetchone())
        self.assertEqual(self.vault.attachment(self.first, attachment)[1], b"Original file bytes")
        self.assertEqual(self.vault.graph_positions()[self.first], [1, 2, 3])
        self.vault.lock()
        self.vault.unlock(PASSWORD, create=False)
        self.assertEqual(list(self.root.glob("*.pre-structure-*")), snapshots)

    def test_trashed_titles_and_aliases_are_available_until_restore(self) -> None:
        [original] = self.vault.create_notes([{"title": "Old name", "body": "Original text"}])
        renamed = self.vault.update_note(original, {"revision": 1, "title": "Ha", "body": "Original text", "tags": []})
        moved = self.vault.update_note(original, {"revision": renamed["revision"], "trashed": True})
        replacement, alias, reference = self.vault.create_notes([
            {"title": "ha", "body": "New text"}, {"title": "Old name", "useAvailableTitle": True},
            {"title": "Link", "body": "[[Ha]]"},
        ])
        self.assertEqual(self.vault.get_note(alias)["title"], "Old name")
        self.assertNotIn(original, {note["id"] for note in self.vault.graph()["nodes"]})
        with self.assertRaises(VaultError):
            self.vault.create_notes([{"title": "Ha"}])
        restored = self.vault.update_note(original, {"revision": moved["revision"], "trashed": False})
        self.assertEqual((restored["title"], restored["body"], restored["aliases"]), ("Ha (2)", "Original text", []))
        self.assertEqual(self.vault.get_note(reference)["links"]["wiki:Ha"], replacement)
        moved_again = self.vault.update_note(original, {"revision": restored["revision"], "trashed": True})
        historical = self.vault.restore_history(original, "note", renamed["revision"], moved_again["revision"])
        self.assertEqual((historical["title"], historical["aliases"]), ("Ha (2)", []))

    def test_failed_schema_migration_rolls_back(self) -> None:
        self.vault.lock()
        with self.vault.connection() as db, db:
            for name in ("entity_fields", "entity_history", "note_history", "legacy_entity_fields"):
                db.execute(f"DROP TABLE {name}")
        from vault import STRUCTURE_SCHEMA
        with patch("vault.STRUCTURE_SCHEMA", (STRUCTURE_SCHEMA[0], "INVALID SCHEMA")):
            with self.assertRaises(sqlite3.DatabaseError):
                self.vault.unlock(PASSWORD, create=False)
        self.assertIsNone(self.vault.cipher)
        with self.vault.connection() as db:
            self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='entity_fields'").fetchone())
        self.vault.unlock(PASSWORD, create=False)
        self.assertEqual(self.vault.get_note(self.first)["title"], "Experiments")

    def test_legacy_merge_conflicts_malformed_and_failed_transaction(self) -> None:
        self.vault.update_entity(self.first, 0, {"status": "done"})
        records = {self.first: {"status": "todo", "due": "2026-02-28", "priority": ["invalid"]},
                   self.second: {"icon": "Private icon text"},
                   "f" * 32: {"status": "note"}, "invalid": {}}
        store = self.vault._store_entity

        def interrupt(database, cipher, note_id, revision, fields):
            if note_id == self.second:
                raise sqlite3.OperationalError("simulated interrupted transaction")
            return store(database, cipher, note_id, revision, fields)

        with patch.object(self.vault, "_store_entity", side_effect=interrupt):
            with self.assertRaises(sqlite3.OperationalError):
                self.vault.migrate_legacy_entities(records)
        with self.vault.connection() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM legacy_entity_fields").fetchone()[0], 0)
        self.assertEqual(self.vault.entity(self.first)["fields"], {"status": "done"})
        first_run = self.vault.migrate_legacy_entities(records)
        self.assertEqual(first_run, {"updated": 2, "unchanged": 0, "conflicts": 1, "invalid": 2, "missing": 1})
        self.assertEqual(self.vault.migrate_legacy_entities(records)["updated"], 0)
        self.vault.restore_history(self.second, "entity", 0, 1)
        self.vault.lock()
        self.vault.unlock(PASSWORD, create=False)
        self.assertEqual(self.vault.migrate_legacy_entities(records)["updated"], 0)
        self.assertEqual(self.vault.entity(self.first)["fields"], {"status": "done", "due": "2026-02-28"})
        self.assertEqual(self.vault.entity(self.second)["fields"], {})
        self.assertNotIn(b"Private icon text", self.vault.path.read_bytes())

    def test_corrupted_entity_ciphertext_is_rejected(self) -> None:
        self.vault.update_entity(self.first, 0, {"status": "done"})
        self.vault.lock()
        with self.vault.connection() as db, db:
            db.execute("UPDATE entity_fields SET sealed = ?", (b"\x00" * 48,))
        with self.assertRaises(VaultError):
            self.vault.unlock(PASSWORD, create=False)
        self.assertIsNone(self.vault.cipher)
        self.assertEqual(self.vault.entities, {})

    def test_relationships_search_and_history(self) -> None:
        self.vault.update_entity(self.first, 0, {"type": "project", "relationships": [
            {"type": "cites", "target": self.second},
        ]})
        self.vault.update_entity(self.second, 0, {"relationships": [{"type": "cites", "target": self.third}]})
        with self.assertRaises(VaultError) as conflict:
            self.vault.update_entity(self.first, 0, {"priority": "high"})
        self.assertEqual(conflict.exception.status, 409)
        result = search_brain(self.vault, "quaternion")
        self.assertEqual(result["results"][0]["source"]["noteId"], self.first)
        self.assertEqual(search_brain(self.vault, "🦄")["count"], 0)
        self.assertIn([self.first, self.second], self.vault.graph()["edges"])
        context = build_context_pack(self.vault, "quaternion", max_chars=1000, hops=2)
        self.assertLessEqual(context["chars"], 1000)
        self.assertEqual({item["id"] for item in context["notes"]}, {self.first, self.second, self.third})
        self.vault.append_to_note(self.first, "New keyword is ossuary.")
        self.assertEqual(search_brain(self.vault, "ossuary")["count"], 1)
        restored = self.vault.restore_history(self.first, "note", 1, 2)
        self.assertNotIn("ossuary", restored["body"])
        self.assertEqual(restored["revision"], 3)
        self.assertEqual(search_brain(self.vault, "ossuary")["count"], 0)
        self.assertEqual(self.vault.history(self.first, "note")["revisions"], [2, 1])

    def test_tasks_preserve_line_endings_and_reject_stale_edits(self) -> None:
        task = self.vault.tasks()[0]
        self.assertEqual(task["text"], "Verify.")
        revised = self.vault.toggle_task({**task, "done": True})
        self.assertIn("\r\n- [x] Verify.", revised["body"])
        with self.assertRaises(VaultError) as error:
            self.vault.toggle_task({**task, "done": False})
        self.assertEqual(error.exception.status, 409)

    def test_portable_roundtrip(self) -> None:
        attachment = self.vault.store_attachment(self.first, "evidence.pdf", b"%PDF preserved")["id"]
        self.vault.set_pinned(self.first, True)
        self.vault.move_graph_node(self.first, [1.5, -3, 2])
        self.vault.update_entity(self.first, 0, {"due": "2027-02-01", "relationships": [
            {"type": "related_to", "target": self.second},
        ]})
        self.vault.append_to_note(self.first, f"[Evidence](attachment:{attachment})")
        server = self.serve()
        status, data = self.request(server, "/api/export/portable")
        self.assertEqual(status, 200)
        with ZipFile(io.BytesIO(data)) as archive:
            self.assertIsNone(archive.testzip())
            exports = json.loads(archive.read("xotira/entities.json"))
            self.assertEqual(exports["relationships"][0]["target"], self.second)
            self.assertIn(SNAPSHOT, archive.namelist())
            self.assertIn(b"evidence.pdf", archive.read("content/Experiments.md"))
        zip_path = self.root / "portable.zip"
        zip_path.write_bytes(data)
        restored_path = self.root / "recovered.xotira"
        restore_snapshot(zip_path, restored_path)
        new_vault = Vault(restored_path)
        new_vault.unlock(PASSWORD, create=False)
        self.assertEqual(new_vault.get_note(self.first), self.vault.get_note(self.first))
        self.assertEqual(new_vault.attachment(self.first, attachment), ("evidence.pdf", b"%PDF preserved"))
        self.assertEqual(new_vault.pinned_notes(), self.vault.pinned_notes())
        self.assertEqual(new_vault.graph_positions(), self.vault.graph_positions())
        self.assertEqual(new_vault.history(self.first, "note"), self.vault.history(self.first, "note"))
        with self.assertRaises(VaultError):
            restore_snapshot(zip_path, restored_path)

    def test_import_zip_obsidian_notion_and_rejected_invalid_paths(self) -> None:
        server = self.serve()

        def archive_of(*entries: tuple[str, str]) -> bytes:
            with io.BytesIO() as out:
                with ZipFile(out, "w") as archive:
                    for path, text in entries:
                        archive.writestr(path, text)
                return out.getvalue()

        obsidian = archive_of(("Notes/A.md", "---\ntags: [study, work]\naliases:\n - Shortcut\n---\n![[asset.png]]"),
                              ("Notes/B.md", "[[Shortcut#Heading]]"), ("Notes/asset.png", "file"),
                              (".obsidian/config.json", "{}"))
        status, raw = self.request(server, "/api/import/zip?source=Obsidian&format=obsidian", obsidian)
        self.assertEqual(status, 201)
        self.assertEqual(json.loads(raw), dict(notes=2, files=1, existing=0, skipped=1, converted=0, unconverted=0))
        notes = {note.title: note for note in self.vault.notes.values() if note.path}
        self.assertEqual(notes["A"].tags, ["study", "work"])
        self.assertIn(notes["A"].id, self.vault.get_note(notes["B"].id)["links"].values())
        notion = archive_of(("Project.html", "<h1>Project</h1><script>Hidden</script><p>Visible</p>"),
                            ("Database.csv", "Name,Status\nProject,Open"))
        status, raw = self.request(server, "/api/import/zip?source=Notion&format=notion", notion)
        self.assertEqual(status, 201)
        result = json.loads(raw)
        self.assertEqual(result["unconverted"], 0)
        self.assertEqual(result["csvRows"], 1)
        row = next(note for note in self.vault.notes.values() if note.title == "Project (1)")
        self.assertIn('"Status": "Open"', row.body)
        project = next(note for note in self.vault.notes.values() if note.title == "Project")
        self.assertIn("Visible", project.body)
        self.assertNotIn("Hidden", project.body)
        old = len(self.vault.notes)
        status, _ = self.request(server, "/api/import/zip?source=Invalid",
                                 archive_of(("Good.md", "Good"), ("../Outside.md", "Invalid")))
        self.assertEqual(status, 400)
        self.assertEqual(len(self.vault.notes), old)

    def test_agent_cannot_approve_and_stale_proposal_preserves_edits(self) -> None:
        server = self.serve()
        self.assertEqual(self.request(server, "/api/agent/config", {"enabled": True, "proposals": True})[0], 200)
        client = XotiraBrain(server.origin, server.agent_key)
        proposed = client.append_note(self.first, "Agent revision")
        review = {"id": proposed["proposalId"], "decision": "approve"}
        self.assertEqual(self.request(server, "/api/review-agent", review, agent=True)[0], 401)
        self.assertNotIn("Agent revision", self.vault.get_note(self.first)["body"])
        self.vault.append_to_note(self.first, "User edit")
        self.assertEqual(self.request(server, "/api/review-agent", review)[0], 409)
        self.assertIn("User edit", self.vault.get_note(self.first)["body"])
        self.assertEqual(self.request(server, "/api/review-agent", {**review, "decision": "reject"})[0], 200)
        self.assertEqual(self.request(server, "/api/review-agent", review)[0], 404)
        status, _ = self.request(server, "/api/agent/config", {"proposals": False})
        self.assertEqual(status, 200)
        with self.assertRaises(ValueError):
            client.save_note("Blocked", "", [])
