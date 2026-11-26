"""End-to-end tests for Xotira v6 features: AI Brain GraphRAG API, Pinning, Mentions, Static Assets."""

from __future__ import annotations

import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from agent_api import brain_stats, build_context_pack, export_brain_json, find_unlinked_mentions, search_brain
from app import STATIC, Server
from vault import Vault


class XotiraV6Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="xotira-v6-test-")
        self.vault_path = Path(self.tmp.name) / "test.xotira"
        self.vault = Vault(self.vault_path)
        self.vault.unlock("strong-test-password-123", create=True)
        ids = self.vault.create_notes([
            {
                "title": "Immersion Metodi",
                "tags": ["Ilm", "Til"],
                "body": "# Immersion Metodi\n\n**Faol immersion** til o‘rganishni tezlashtiradi. Bog‘liq: [[IELTS]].",
            },
            {
                "title": "IELTS",
                "tags": ["Ilm"],
                "body": "# IELTS Tayyorgarlik\n\nListening va Speaking uchun Immersion Metodi juda foydali.",
            },
            {
                "title": "RIWI Agent",
                "tags": ["AI", "Loyiha"],
                "body": "# RIWI\n\nMahalliy AI agent [[Immersion Metodi]] va boshqa qaydlarni o‘qiydi.",
            },
        ])
        self.id_immersion, self.id_ielts, self.id_riwi = ids

    def tearDown(self) -> None:
        self.vault.lock()
        self.tmp.cleanup()

    def test_graph_includes_preview_words_and_pinning(self) -> None:
        self.vault.set_pinned(self.id_immersion, True)
        g = self.vault.graph()
        by_id = {n["id"]: n for n in g["nodes"]}
        self.assertTrue(by_id[self.id_immersion]["pinned"])
        self.assertFalse(by_id[self.id_ielts]["pinned"])
        self.assertGreater(by_id[self.id_immersion]["words"], 3)
        self.assertIn("Faol immersion", by_id[self.id_immersion]["preview"])

    def test_unlinked_mentions(self) -> None:
        # IELTS mentions "Immersion Metodi" without [[...]]
        mentions = find_unlinked_mentions(self.vault, self.id_immersion)
        titles = [m["title"] for m in mentions]
        self.assertIn("IELTS", titles)
        self.assertNotIn("RIWI Agent", titles)  # already linked with [[Immersion Metodi]]

    def test_graphrag_search_and_context_pack(self) -> None:
        res = search_brain(self.vault, "Immersion")
        self.assertGreaterEqual(res["count"], 1)
        self.assertEqual(res["results"][0]["title"], "Immersion Metodi")

        pack = build_context_pack(self.vault, "Immersion", max_chars=5000, hops=1)
        self.assertIn("Immersion Metodi", pack["context"])
        self.assertIn("IELTS", pack["context"])
        self.assertGreaterEqual(len(pack["notes"]), 2)

        stats = brain_stats(self.vault)
        self.assertEqual(stats["notes"], 3)
        self.assertGreaterEqual(stats["links"], 2)

        exported = export_brain_json(self.vault)
        self.assertEqual(exported["schema"], "xotira-brain/1.0")
        self.assertEqual(len(exported["nodes"]), 3)

    def test_append_and_http_agent_api(self) -> None:
        server = Server(self.vault, None, port=0)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()
        try:
            conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
            # Check all static assets exist and serve 200
            for route in STATIC:
                conn.request("GET", route, headers={"Host": server.host})
                resp = conn.getresponse()
                resp.read()
                self.assertEqual(resp.status, 200, f"Static route failed: {route}")

            # Agent API health with X-Brain-Key
            owner = {"Host": server.host, "Authorization": f"Bearer {server.token}",
                     "Origin": server.origin, "Content-Type": "application/json"}
            conn.request("POST", "/api/agent/config", json.dumps({"enabled": True, "proposals": True}), owner)
            resp = conn.getresponse()
            resp.read()
            self.assertEqual(resp.status, 200)
            conn.request("GET", "/api/agent/health", headers={"Host": server.host, "X-Brain-Key": server.agent_key})
            resp = conn.getresponse()
            data = json.loads(resp.read().decode())
            self.assertEqual(resp.status, 200)
            self.assertTrue(data["ok"])
            self.assertEqual(data["notes"], 3)

            # Agent API create note
            payload = json.dumps({"title": "Agent Xotirasi", "body": "# Yangi\nAgent yozdi.", "tags": ["AI"]}).encode()
            conn.request(
                "POST",
                "/api/agent/notes",
                body=payload,
                headers={"Host": server.host, "X-Brain-Key": server.agent_key, "Content-Type": "application/json"},
            )
            resp = conn.getresponse()
            created = json.loads(resp.read().decode())
            self.assertEqual(resp.status, 202)
            self.assertNotIn("Agent Xotirasi", [note.title for note in self.vault.notes.values()])
            conn.request("POST", "/api/review-agent",
                         json.dumps({"id": created["proposalId"], "decision": "approve"}), owner)
            resp = conn.getresponse()
            created = json.loads(resp.read())["note"]
            self.assertEqual(resp.status, 200)
            self.assertEqual(created["title"], "Agent Xotirasi")

            # Agent API append note
            append_body = json.dumps({"text": "- Yangi qator qo‘shildi"}).encode()
            conn.request(
                "POST",
                f"/api/agent/notes/{created['id']}/append",
                body=append_body,
                headers={"Host": server.host, "X-Brain-Key": server.agent_key, "Content-Type": "application/json"},
            )
            resp = conn.getresponse()
            proposed = json.loads(resp.read().decode())
            self.assertEqual(resp.status, 202)
            conn.request("POST", "/api/review-agent",
                         json.dumps({"id": proposed["proposalId"], "decision": "approve"}), owner)
            resp = conn.getresponse()
            appended = json.loads(resp.read())["note"]
            self.assertEqual(resp.status, 200)
            self.assertIn("Yangi qator qo‘shildi", appended["body"])

            # Agent API unauthorized rejection
            conn.request("GET", "/api/agent/health", headers={"Host": server.host, "X-Brain-Key": "wrong-key"})
            resp = conn.getresponse()
            resp.read()
            self.assertEqual(resp.status, 401)
            conn.close()
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
