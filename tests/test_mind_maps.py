from __future__ import annotations

import hashlib
import http.client
import io
import json
import tempfile
import threading
import unittest
from pathlib import Path
from zipfile import ZipFile

from app import Server

from account_fixture import fixture_account
from mind_map import new_map
from vault import Vault, VaultError


class MindMapTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.vault = Vault(Path(self.tmp.name) / "test.xotira")
        self.password = "mind map secure password"
        self.vault.unlock(self.password, create=True)

    def test_graph_topic_terms_follow_note_revisions(self) -> None:
        [note] = self.vault.create_notes([{"title": "Shared topic", "body": "# Polarization\nQuantum photons"}])
        self.assertIn("polarization", self.vault.graph()["nodes"][0]["topicTerms"])
        self.vault.update_note(note, {"title": "Shared topic", "body": "Spectrometry", "revision": 1, "tags": []})
        self.assertEqual(self.vault.graph()["nodes"][0]["topicTerms"], ["spectrometry"])
        self.vault.store_attachment(note, "Sources.txt", "Birlashgan dalillar haqida matn".encode())
        self.assertIn("dalillar", self.vault.graph()["files"][0]["topicTerms"])
        self.vault.lock()
        self.assertFalse(self.vault.topic_cache)

    def test_vault_stores_branches_links_and_rejects_stale_edits(self) -> None:
        [target] = self.vault.create_notes([{"title": "IELTS", "body": "Speaking practice"}])
        file = self.vault.create_mind_map({"title": "Study map"})
        _, blob = self.vault.attachment(file["noteId"], file["id"])
        original = hashlib.sha256(blob).hexdigest()
        graph = json.loads(blob)
        child = "1" * 32
        graph["topics"].append({"id": child, "parent": graph["root"], "title": "Archived plan",
                                "note": "private idea", "ref": target, "collapsed": True})
        graph["links"].append({"a": graph["root"], "b": child})
        result = self.vault.update_mind_map(file["noteId"], file["id"], {"map": graph, "checksum": original})
        self.assertNotIn(b"private idea", self.vault.path.read_bytes())
        self.assertIn([file["id"], target], self.vault.graph()["edges"])
        with self.assertRaises(VaultError) as ctx:
            self.vault.update_mind_map(file["noteId"], file["id"], {"map": graph, "checksum": original})
        self.assertEqual(ctx.exception.status, 409)
        graph["topics"][-1]["parent"] = child
        with self.assertRaises(VaultError):
            self.vault.update_mind_map(file["noteId"], file["id"], {"map": graph, "checksum": result["checksum"]})
        self.vault.lock()
        self.vault.unlock(self.password, create=False)
        _, current = self.vault.attachment(file["noteId"], file["id"])
        self.assertEqual(json.loads(current)["topics"][-1]["parent"], graph["root"])

    def test_branch_positions_and_files_follow_the_linked_note(self) -> None:
        file = self.vault.create_mind_map({"title": "Research"})
        note_id, file_id = file["noteId"], file["id"]
        _, raw = self.vault.attachment(note_id, file_id)
        doc = json.loads(raw)
        branch_id = "2" * 32
        doc["topics"].append({"id": branch_id, "parent": doc["root"], "title": "Results",
                              "note": "Findings from the field", "shape": "circle", "offset": [140, -90]})
        saved = self.vault.update_mind_map(note_id, file_id, {"map": doc, "checksum": hashlib.sha256(raw).hexdigest()})
        opened = self.vault.update_mind_map(note_id, file_id, {"openTopic": branch_id, "checksum": saved["checksum"]})
        topic_note_id = opened["noteId"]
        duplicate = self.vault.update_mind_map(note_id, file_id, {"openTopic": branch_id, "checksum": opened["checksum"]})
        self.assertEqual(duplicate["noteId"], topic_note_id)
        self.assertEqual(self.vault.get_note(topic_note_id)["body"], "Findings from the field")
        expected = ["figure.png", "sources.pdf", "brief.docx", "slides.pptx"]
        for name in expected:
            data = name.encode()
            attachment = self.vault.store_attachment(topic_note_id, name, data)
            self.assertEqual(self.vault.attachment(topic_note_id, attachment["id"]), (name, data))
        self.vault.lock()
        self.vault.unlock(self.password, create=False)
        _, current = self.vault.attachment(note_id, file_id)
        topic = json.loads(current)["topics"][1]
        self.assertEqual((topic["shape"], topic["offset"], topic["ref"]), ("circle", [140, -90], topic_note_id))
        self.assertEqual([file["name"] for file in self.vault.get_note(topic_note_id)["attachments"]], expected)
        self.assertIn([file_id, topic_note_id], self.vault.graph()["edges"])

    def test_attached_map_update_keeps_branch_side_and_linked_note(self) -> None:
        owner, link = self.vault.create_notes([{"title": "Owner", "body": "Text stays here"}, {"title": "Linked note"}])
        file = self.vault.create_mind_map({"title": "Map in a note", "noteId": owner})
        _, old = self.vault.attachment(owner, file["id"])
        layout = json.loads(old)
        branch = "4" * 32
        layout["topics"].append({"id": branch, "parent": layout["root"], "side": "left",
                                 "title": "On the left", "ref": link})
        result = self.vault.update_mind_map(owner, file["id"],
                                            {"map": layout, "checksum": hashlib.sha256(old).hexdigest()})
        data = self.vault.attachment(owner, file["id"])[1]
        self.assertEqual(json.loads(data)["topics"][1]["side"], "left")
        self.assertEqual(self.vault.get_note(owner)["body"], "Text stays here")
        layout["topics"].pop()
        self.vault.update_mind_map(owner, file["id"], {"map": layout, "checksum": result["checksum"]})
        self.assertEqual(self.vault.get_note(link)["title"], "Linked note")

    def test_file_trash_roundtrip_keeps_its_owner_and_siblings(self) -> None:
        file = self.vault.create_mind_map({"title": "Research"})
        note_id, file_id = file["noteId"], file["id"]
        sibling = self.vault.store_attachment(note_id, "sources.txt", b"useful")
        self.vault.trash_attachment(note_id, file_id, "move")
        self.assertEqual([item["id"] for item in self.vault.get_note(note_id)["attachments"]], [sibling["id"]])
        self.assertEqual([item["id"] for item in self.vault.graph(trash=True)["files"]], [file_id])
        name, raw = self.vault.attachment(note_id, file_id)
        self.assertTrue(name.endswith(".mindmap"))
        with self.assertRaises(VaultError):
            self.vault.update_mind_map(note_id, file_id, {"map": json.loads(raw), "checksum": hashlib.sha256(raw).hexdigest()})
        self.vault.trash_attachment(note_id, file_id, "restore")
        self.assertFalse(self.vault.graph(trash=True)["files"])
        self.assertEqual(self.vault.attachment(note_id, file_id)[1], raw)
        self.vault.trash_attachment(note_id, file_id, "move")
        self.vault.delete_trashed()
        with self.assertRaises(VaultError):
            self.vault.attachment(note_id, file_id)
        self.assertEqual(self.vault.attachment(note_id, sibling["id"])[1], b"useful")
        self.assertEqual(self.vault.get_note(note_id)["title"], "Research")

    def test_http_create_import_and_portable_export(self) -> None:
        server = Server(self.vault, None, account=fixture_account())
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def request(method: str, route: str, body: dict | None = None) -> tuple[int, bytes]:
            conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
            headers = {"Authorization": "Bearer " + server.token, "Origin": server.origin}
            if body is not None:
                headers["Content-Type"] = "application/json"
            try:
                conn.request(method, route, body=json.dumps(body) if body is not None else None, headers=headers)
                response = conn.getresponse()
                return response.status, response.read()
            finally:
                conn.close()

        try:
            for asset in ("graph-topics.js", "mind-map.js", "mind-map-model.js", "trash-drop.js"):
                self.assertEqual(request("GET", f"/{asset}")[0], 200)
            status, raw = request("POST", "/api/mind-maps", {"title": "Focus"})
            self.assertEqual(status, 201)
            created = json.loads(raw)
            route = f"/api/notes/{created['noteId']}/files/{created['id']}"
            status, raw = request("GET", route)
            self.assertEqual(status, 200)
            doc = json.loads(raw)
            doc["topics"][0]["title"] = "Updated root"
            self.assertEqual(request("POST", route + "?view=mind-map",
                                     {"map": doc, "checksum": hashlib.sha256(raw).hexdigest()})[0], 200)
            status, raw = request("POST", "/api/mind-maps", {"map": doc, "noteId": created["noteId"]})
            self.assertEqual(status, 201)
            imported = json.loads(raw)
            self.assertEqual(imported["noteId"], created["noteId"])
            self.assertNotEqual(imported["id"], created["id"])
            status, snapshot = request("GET", route)
            self.assertEqual(status, 200)
            status, branch = request("POST", route + "?view=mind-map",
                                     {"openTopic": doc["root"], "checksum": hashlib.sha256(snapshot).hexdigest()})
            self.assertEqual(status, 200)
            self.assertEqual(request("GET", f"/api/notes/{json.loads(branch)['noteId']}")[0], 200)
            trash_file = {"noteId": created["noteId"], "id": created["id"]}
            self.assertEqual(request("POST", "/api/trash", {"action": "move", "file": trash_file})[0], 200)
            self.assertEqual(request("POST", "/api/trash", {"action": "restore", "file": trash_file})[0], 200)
            invalid = new_map("Invalid")
            invalid["links"] = [{"a": invalid["root"], "b": "0" * 32}]
            self.assertEqual(request("POST", "/api/mind-maps", {"map": invalid})[0], 400)
            status, portable = request("GET", "/api/export/portable")
            self.assertEqual(status, 200)
            with ZipFile(io.BytesIO(portable)) as archive:
                exported = [path for path in archive.namelist() if path.endswith(".mindmap")]
                self.assertEqual(len(exported), 2)
                self.assertTrue(all(json.loads(archive.read(path))["topics"][0]["title"] == "Updated root"
                                    for path in exported))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
