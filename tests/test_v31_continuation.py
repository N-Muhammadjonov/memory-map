import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
from zipfile import ZipFile

import ai_providers
import markdown_mirror
import settings
from agent_api import search_brain
from app import Handler, add_markdown
from archive_import import zip_entries
from telemetry import check_for_updates
from test_v25_e2e_fresh import _FakeServer, http_call
from vault import Vault, VaultError


class ContinuationTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.vault = Vault(self.root / "test.xotira")
        self.vault.unlock("baseline test password", create=True)

    def note(self, title, body):
        return self.vault.create_notes([{"title": title, "body": body}])[0]

    def test_provider_keys_are_inactive_until_configured_and_never_returned(self):
        status = ai_providers.connection_status(self.vault)
        self.assertEqual(len(status["providers"]), 10)
        self.assertFalse(any(item["configured"] for item in status["providers"]))
        key = "test-provider-key-canary"
        for entry in status["providers"]:
            identity = entry["id"]
            configured = ai_providers.save_connection(self.vault, {
                "action": "save", "provider": identity, "apiKey": key,
            })
            self.assertNotIn(key, json.dumps(configured))
            self.assertEqual(ai_providers.read(self.vault)[identity]["key"], key)
        self.assertNotIn(key.encode(), self.vault.path.read_bytes())
        self.assertNotIn(key.encode(), ai_providers.credential_path(self.vault.path).read_bytes())
        ai_providers.save_connection(self.vault, {"action": "remove", "provider": "openai"})
        self.assertNotIn("openai", ai_providers.read(self.vault))

    def test_legacy_profile_migrates_without_entering_backup(self):
        settings.save(self.vault, ai_providers.SETTING, {"qwen": {"key": "test-key", "workspace": "fixture"}})
        ai_providers.migrate(self.vault)
        self.assertIsNone(settings.load(self.vault, ai_providers.SETTING, None))
        self.assertEqual(ai_providers.read(self.vault)["qwen"]["workspace"], "fixture")
        before = Vault(self.vault.path.with_name(self.vault.path.name + ".pre-ai-storage.xotira"))
        before.unlock("baseline test password", create=False)
        self.assertIsNone(settings.load(before, ai_providers.SETTING, None))
        ai_providers.migrate(self.vault)
        self.assertEqual(ai_providers.read(self.vault)["qwen"]["key"], "test-key")

    def test_saved_database_view_persists_across_lock_and_recovery(self):
        handler = object.__new__(Handler)
        handler.server = MagicMock(vault=self.vault)
        handler.server.telemetry.blocked.return_value = False
        handler.write_json = MagicMock()
        handler.command = "POST"
        view = {"id": "view_test", "name": "Search canary", "mode": "tasks", "taskFilter": "done", "filterText": "demo"}
        handler.handle_api("/api/database/views", {}, {"action": "save", "view": view})
        self.assertEqual(handler.write_json.call_args.args[0]["views"][0]["taskFilter"], "done")
        self.assertNotIn(b"Search canary", self.vault.path.read_bytes())
        key = self.vault.generate_recovery_key()
        self.vault.lock()
        self.vault.unlock_with_recovery(key, "recovered test password")
        self.assertFalse(self.vault.has_recovery_key())
        self.assertEqual(settings.load(self.vault, "database_views", [])[0]["name"], "Search canary")
        handler.handle_api("/api/database/views", {}, {"action": "remove", "id": "view_test"})
        self.assertEqual(handler.write_json.call_args.args[0], {"views": []})
        self.vault.lock()
        with self.assertRaises(VaultError):
            self.vault.unlock_with_recovery(key, "another test password")

    def test_recovery_preserves_history_files_note_passwords_and_settings(self):
        note_id = self.note("Old title", "Original body")
        self.vault.update_note(note_id, {"revision": 1, "title": "Old title", "tags": [], "body": "New body"})
        asset = self.vault.store_attachment(note_id, "attachment.txt", b"file bytes")
        self.vault.set_note_password(note_id, "private note password")
        ai_providers.save_connection(self.vault, {"provider": "openai", "apiKey": "test-key", "action": "save"})
        key = self.vault.generate_recovery_key()
        self.vault.lock()
        self.vault.unlock_with_recovery(key, "changed password for test")
        self.assertTrue(self.vault.get_note(note_id)["locked"])
        self.vault.unlock_note(note_id, "private note password")
        self.assertEqual(self.vault.history(note_id, "note", 1)["body"], "Original body")
        self.assertEqual(self.vault.attachment(note_id, asset["id"])[1], b"file bytes")
        self.assertTrue(ai_providers.connection_status(self.vault)["providers"][0]["configured"])
        self.vault.lock()
        self.vault.unlock("changed password for test", create=False)
        self.assertFalse(self.vault.has_recovery_key())

    def test_locked_notes_do_not_appear_in_content_queries_or_plain_exports(self):
        protected = self.note("Protected", "- [ ] unique private content")
        asset = self.vault.store_attachment(protected, "private.txt", b"example data")
        self.vault.set_note_password(protected, "private note password")
        self.assertEqual(self.vault.get_note(protected)["body"], "- [ ] unique private content")
        path = self.root / "mirror"
        markdown_mirror.set_config(self.vault, str(path), True)
        markdown_mirror.sync_mirror(self.vault)
        self.assertFalse((path / "Protected.md").exists())
        self.assertFalse((path / "assets").exists())
        with ZipFile(io.BytesIO(), "w") as archive:
            add_markdown(self.vault, archive)
            self.assertNotIn("Protected.md", archive.namelist())
        self.vault.lock_note(protected)
        self.assertFalse(self.vault.tasks())
        self.assertFalse(self.vault.graph("unique private content")["hits"])
        self.assertEqual(search_brain(self.vault, "unique private content")["results"], [])
        self.assertFalse(self.vault.list_attachments())
        for action in (lambda: self.vault.attachment(protected, asset["id"]),
                       lambda: self.vault.append_to_note(protected, "extra")):
            with self.assertRaises(VaultError):
                action()

    def test_mirror_preserves_external_edits_and_removes_owned_stale_notes(self):
        note_id = self.note("First note", "Initial content")
        second = self.note("Second note", "Unchanged content")
        path = self.root / "mirror"
        markdown_mirror.set_config(self.vault, str(path), True)
        self.assertEqual(markdown_mirror.sync_mirror(self.vault)["files"], 2)
        (path / "First note.md").write_text("edited externally")
        self.vault.update_note(note_id, {"revision": 1, "title": "First note", "tags": [], "body": "New body"})
        with self.assertRaises(VaultError):
            markdown_mirror.sync_mirror(self.vault)
        self.assertEqual((path / "First note.md").read_text(), "edited externally")
        self.vault.set_note_password(note_id, "private note password")
        self.vault.set_note_password(second, "another note password")
        markdown_mirror.sync_mirror(self.vault)
        self.assertEqual((path / "First note.md").read_text(), "edited externally")
        self.assertFalse((path / "Second note.md").exists())

    def test_notion_csv_and_obsidian_nested_markdown_import(self):
        for notion, source in ((False, "Obsidian"), (True, "Notion")):
            with self.subTest(source=source), ZipFile(io.BytesIO(), "w") as archive:
                archive.writestr("Folder/Plan.md", "# Plan\n\nSee [[Second]].")
                archive.writestr("Folder/Second.md", "# Second")
                if notion:
                    archive.writestr("Tasks.csv", "Name,Status\nRead,Done\n")
                summary = {}
                counts = self.vault.import_folder(source, zip_entries(archive, notion=notion, summary=summary))
                self.assertGreaterEqual(counts["notes"], 2)
                if notion:
                    self.assertEqual(summary["csvRows"], 1)
        self.assertEqual(len(self.vault.graph()["nodes"]), 5)

    def test_legacy_connection_route_is_authenticated_and_disconnected(self):
        server = _FakeServer(self.vault)
        path = "/api/ai-providers/check"
        data = {"body": b'{"provider":"openai"}', "headers": {"Content-Type": "application/json"}}
        self.assertEqual(http_call(server, "POST", path, auth=False, **data)[0], 401)
        code, _, payload = http_call(server, "POST", path, auth=True, **data)
        self.assertEqual((code, json.loads(payload)), (200, {"ok": False, "errorCode": "not_connected"}))

    def test_successful_backup_reminder_timestamp_survives_a_fresh_session(self):
        server = _FakeServer(self.vault)
        code, headers, content = http_call(server, "GET", "/api/backup", auth=True)
        self.assertEqual(code, 200)
        self.assertTrue(headers["content-disposition"].endswith(".xotira"))
        self.assertTrue(content.startswith(b"SQLite format 3"))
        first_timestamp = server.last_backup
        self.assertTrue(first_timestamp)
        self.vault.lock()
        reopened = _FakeServer(self.vault)
        code, _, _ = http_call(reopened, "POST", "/api/unlock", auth=True,
                               headers={"Content-Type": "application/json"},
                               body=b'{"password":"baseline test password"}')
        self.assertEqual(code, 200)
        code, _, payload = http_call(reopened, "GET", "/api/status", auth=True)
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(payload)["lastBackup"], first_timestamp)

    def test_updates_use_numeric_tags_and_repository_release_urls(self):
        repo = "fixtures/memory-map-test"
        data = {"tag_name": "v31.0.0", "html_url": "https://github.com/other/project/releases/tag/v31"}
        fetch = lambda _url: data
        same = check_for_updates(repo, current="v31", fetch_json=fetch)
        self.assertFalse(same["available"])
        update = check_for_updates(repo, current="v30", fetch_json=fetch)
        self.assertTrue(update["available"])
        self.assertEqual(update["url"], f"https://github.com/{repo}/releases")
        data["tag_name"] = "v31.1.0-beta.1"
        self.assertFalse(check_for_updates(repo, current="v31", fetch_json=fetch, ttl_seconds=0)["available"])
