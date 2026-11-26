"""v26 privacy regressions: a trashed or deleted note must not stay public; share ZIP carries only chosen notes."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile
import io

from account_transfer import build_encrypted_transfer_zip, import_encrypted_transfer_zip
from public_share import configure_note_share, fetch_public_snapshot, list_public_shares
from vault import Vault


class PrivacyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.vault = Vault(self.root / "a.xotira")
        self.vault.unlock("account-a-strong-pass!", create=True)
        self.public, self.private = self.vault.create_notes([
            {"title": "Public page", "body": "Open text", "tags": ["blog"]},
            {"title": "Private page", "body": "SECRET-LINE-42", "tags": ["money"]},
        ])

    def tearDown(self) -> None:
        self.vault.lock()
        self.tmp.cleanup()

    def trash(self, note_id: str) -> None:
        note = self.vault.get_note(note_id)
        self.vault.update_note(note_id, {"revision": note["revision"], "trashed": True})

    def test_trashing_unpublishes(self) -> None:
        slug = configure_note_share(self.vault, self.public, {"enabled": True})["slug"]
        self.assertIsNotNone(fetch_public_snapshot(self.vault, slug))
        self.trash(self.public)
        self.assertIsNone(fetch_public_snapshot(self.vault, slug))
        self.assertEqual(list_public_shares(self.vault), [])

    def test_permanent_delete_unpublishes(self) -> None:
        slug = configure_note_share(self.vault, self.public, {"enabled": True})["slug"]
        self.trash(self.public)
        self.vault.delete_trashed()
        self.assertIsNone(fetch_public_snapshot(self.vault, slug))

    def test_trashing_other_note_keeps_public_page(self) -> None:
        slug = configure_note_share(self.vault, self.public, {"enabled": True})["slug"]
        self.trash(self.private)
        self.assertIsNotNone(fetch_public_snapshot(self.vault, slug))

    def test_trash_works_in_vault_that_never_published(self) -> None:
        self.trash(self.private)
        self.vault.delete_trashed()
        self.assertNotIn(self.private, self.vault.notes)

    def test_share_zip_has_only_selected_notes(self) -> None:
        data, stats = build_encrypted_transfer_zip(self.vault, "transfer-pass-2026", note_ids=[self.public])
        self.assertEqual(stats["notes"], 1)
        self.assertNotIn(b"SECRET-LINE-42", data)
        other = Vault(self.root / "b.xotira")
        other.unlock("account-b-strong-pass!", create=True)
        import_encrypted_transfer_zip(other, data, "transfer-pass-2026")
        titles = {n.title for n in other.notes.values() if not n.storage_only}
        self.assertEqual(titles, {"Public page"})
        other.lock()


if __name__ == "__main__":
    unittest.main()
