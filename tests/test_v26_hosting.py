"""v26: publish one note to a public host, serve it, remove it when the note is trashed."""

from __future__ import annotations

import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import hosting
from publish_server import make_server
from vault import Vault, VaultError
from public_share import configure_note_share

KEY = "test-publish-key-0123456789"


def fetch(url: str):
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            return r.status, r.read().decode(), r.headers
    except urllib.error.HTTPError as e:
        return e.code, "", e.headers


class HostingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.server = make_server("127.0.0.1", 0, root / "pages", KEY)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.vault = Vault(root / "a.xotira")
        self.vault.unlock("account-a-strong-pass!", create=True)
        self.vault.unpublished_hook = lambda ids: hosting.unhost(self.vault, ids)
        self.pub, self.priv = self.vault.create_notes([
            {"title": "Hosted note", "body": "Visible text here", "tags": ["t"]},
            {"title": "Private note", "body": "PRIVATE-MARKER-77"},
        ])
        configure_note_share(self.vault, self.pub, {"enabled": True})
        hosting.set_config(self.vault, self.base, KEY)

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.vault.lock()
        self.tmp.cleanup()

    def trash(self, note_id: str) -> None:
        note = self.vault.get_note(note_id)
        self.vault.update_note(note_id, {"revision": note["revision"], "trashed": True})

    def test_publish_serve_update_and_remove(self) -> None:
        status = hosting.publish(self.vault, self.pub)
        self.assertTrue(status["hosted"])
        code, body, headers = fetch(status["hostedUrl"])
        self.assertEqual(code, 200)
        self.assertIn("Visible text here", body)
        self.assertNotIn("PRIVATE-MARKER-77", body)
        self.assertIn("script-src 'none'", headers["Content-Security-Policy"])
        first = status["hostedUrl"]
        note = self.vault.get_note(self.pub)
        self.vault.update_note(self.pub, {"revision": note["revision"], "title": "Hosted note", "body": "Changed text", "tags": ["t"]})
        again = hosting.publish(self.vault, self.pub)
        self.assertEqual(again["hostedUrl"], first)
        self.assertIn("Changed text", fetch(first)[1])
        hosting.unhost(self.vault, [self.pub])
        self.assertEqual(fetch(first)[0], 404)
        self.assertFalse(hosting.page_status(self.vault, self.pub)["hosted"])

    def test_trashing_removes_hosted_copy(self) -> None:
        url = hosting.publish(self.vault, self.pub)["hostedUrl"]
        self.assertEqual(fetch(url)[0], 200)
        self.trash(self.pub)
        self.assertEqual(fetch(url)[0], 404)

    def test_locked_page_hides_text_and_allows_only_its_script(self) -> None:
        status = hosting.publish(self.vault, self.pub, "long-lock-password")
        code, body, headers = fetch(status["hostedUrl"])
        self.assertEqual(code, 200)
        self.assertNotIn("Visible text here", body)
        self.assertIn("script-src 'unsafe-inline'", headers["Content-Security-Policy"])
        with self.assertRaises(VaultError):
            hosting.publish(self.vault, self.pub, "short")

    def test_wrong_key_and_missing_config_are_refused(self) -> None:
        hosting.set_config(self.vault, self.base, "another-wrong-key-0123456")
        with self.assertRaises(VaultError):
            hosting.publish(self.vault, self.pub)
        hosting.set_config(self.vault, "", "", clear=True)
        with self.assertRaises(VaultError):
            hosting.publish(self.vault, self.pub)

    def test_unreachable_host_is_retried_until_page_is_gone(self) -> None:
        url = hosting.publish(self.vault, self.pub)["hostedUrl"]
        hosting.set_config(self.vault, "http://127.0.0.1:9", KEY)  # nothing listens here
        self.trash(self.pub)
        self.assertEqual(fetch(url)[0], 200)  # still online: removal failed ...
        self.assertEqual(hosting.page_status(self.vault, self.pub)["pendingRemovals"], 1)  # ... but remembered
        hosting.set_config(self.vault, self.base, KEY)
        self.assertEqual(hosting.unhost(self.vault, []), [])
        self.assertEqual(fetch(url)[0], 404)

    def test_endpoint_validation(self) -> None:
        for bad in ["http://example.com", "https://user:pw@example.com", "https://example.com/path", "ftp://x.com"]:
            with self.assertRaises(VaultError):
                hosting.check_endpoint(bad, KEY)
        self.assertEqual(hosting.check_endpoint("https://pages.example.com/", KEY)["url"], "https://pages.example.com")

    def test_server_rejects_bad_requests(self) -> None:
        for method, path in [("POST", "/api/pages"), ("DELETE", "/api/pages/" + "A" * 22)]:
            req = urllib.request.Request(self.base + path, data=b"{}" if method == "POST" else None, method=method,
                                         headers={"Authorization": "Bearer nope", "Content-Type": "application/json"})
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(req, timeout=5)
            self.assertEqual(caught.exception.code, 401)
        self.assertEqual(fetch(self.base + "/p/../../etc/passwd")[0], 404)
        self.assertEqual(fetch(self.base + "/p/" + "A" * 22)[0], 404)


if __name__ == "__main__":
    unittest.main()
