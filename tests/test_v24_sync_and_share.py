"""Tests for Xotira v24 encrypted account ZIP transfer and isolated single-note public publishing."""

from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

from account_transfer import (
    MANIFEST_ENTRY,
    PAYLOAD_ENTRY,
    build_encrypted_transfer_zip,
    import_encrypted_transfer_zip,
)
from public_share import (
    configure_note_share,
    export_static_public_html,
    export_static_public_site_zip,
    fetch_public_snapshot,
    get_note_share_status,
    list_public_shares,
    make_unlock_cookie,
    render_public_page_html,
    verify_share_password,
    verify_unlock_cookie,
)
from vault import Vault, VaultError


class V24SyncAndShareTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.vault_a = Vault(self.root / "account_a.xotira")
        self.vault_a.unlock("account-a-strong-pass!", create=True)
        self.vault_b = Vault(self.root / "account_b.xotira")
        self.vault_b.unlock("account-b-strong-pass!", create=True)

    def tearDown(self) -> None:
        self.vault_a.lock()
        self.vault_b.lock()
        self.tmp.cleanup()

    def test_encrypted_account_zip_roundtrip_privacy_and_conflicts(self) -> None:
        ids = self.vault_a.create_notes([
            {"title": "Architecture Plan", "body": "# Architecture\n\nSecret roadmap details.", "tags": ["Core", "Design"]},
            {"title": "Private Journal", "body": "Very confidential personal entry.", "tags": ["Private"]},
        ])
        self.vault_a.update_entity(ids[0], 0, {"status": "doing", "priority": "high"})
        self.vault_a.store_attachment(ids[0], "spec.txt", b"encrypted-attachment-content")

        zip_bytes, export_stats = build_encrypted_transfer_zip(self.vault_a, "transfer-pass-2026")
        self.assertEqual(export_stats, {"notes": 2, "attachments": 1})

        # Ensure ZERO plaintext leaks inside the ZIP
        self.assertNotIn(b"Secret roadmap details", zip_bytes)
        self.assertNotIn(b"confidential personal entry", zip_bytes)
        self.assertNotIn(b"encrypted-attachment-content", zip_bytes)
        with ZipFile(io.BytesIO(zip_bytes)) as archive:
            self.assertEqual(set(archive.namelist()), {MANIFEST_ENTRY, PAYLOAD_ENTRY})

        # Wrong passphrase must fail with 403
        with self.assertRaises(VaultError) as wrong_pw:
            import_encrypted_transfer_zip(self.vault_b, zip_bytes, "wrong-passphrase-123")
        self.assertEqual(wrong_pw.exception.status, 403)

        # Tampered payload must fail integrity check
        tampered_buf = io.BytesIO()
        with ZipFile(io.BytesIO(zip_bytes)) as src, ZipFile(tampered_buf, "w") as dst:
            dst.writestr(MANIFEST_ENTRY, src.read(MANIFEST_ENTRY))
            raw_enc = bytearray(src.read(PAYLOAD_ENTRY))
            raw_enc[-1] ^= 0xFF
            dst.writestr(PAYLOAD_ENTRY, bytes(raw_enc))
        with self.assertRaises(VaultError):
            import_encrypted_transfer_zip(self.vault_b, tampered_buf.getvalue(), "transfer-pass-2026")

        # Valid import into Account B
        summary = import_encrypted_transfer_zip(self.vault_b, zip_bytes, "transfer-pass-2026", conflict="rename")
        self.assertEqual(summary, {"notes": 2, "attachments": 1, "skipped": 0, "renamed": 0})
        titles_b = {n.title for n in self.vault_b.notes.values()}
        self.assertEqual(titles_b, {"Architecture Plan", "Private Journal"})

        # Re-importing with conflict="skip" skips duplicates
        skip_summary = import_encrypted_transfer_zip(self.vault_b, zip_bytes, "transfer-pass-2026", conflict="skip")
        self.assertEqual(skip_summary["skipped"], 2)
        self.assertEqual(skip_summary["notes"], 0)

        # Re-importing with conflict="rename" keeps both
        rename_summary = import_encrypted_transfer_zip(self.vault_b, zip_bytes, "transfer-pass-2026", conflict="rename")
        self.assertEqual(rename_summary["renamed"], 2)
        self.assertEqual(rename_summary["notes"], 2)

    def test_single_note_public_isolation_xss_and_article_lock(self) -> None:
        ids = self.vault_a.create_notes([
            {
                "title": "Public Guide",
                "body": (
                    "# Public Guide\n\n"
                    "See [[Secret Vault Note]] and <script>alert(1)</script>.\n\n"
                    "## Code Sample\n\n"
                    "```python\n" + "\n".join(f"x_{i} = {i}" for i in range(25)) + "\n```\n"
                ),
                "tags": ["Docs"],
            },
            {
                "title": "Secret Vault Note",
                "body": "TOP SECRET PRIVATE CONTENT MUST NEVER LEAK",
                "tags": ["Private"],
            },
        ])
        public_id, secret_id = ids

        # Secret note is NOT published
        self.assertFalse(get_note_share_status(self.vault_a, secret_id)["enabled"])

        # Publish ONLY Public Guide with gitbook theme and optional ArticleLock password
        share_info = configure_note_share(
            self.vault_a,
            public_id,
            {"enabled": True, "slug": "public-guide-v24", "theme": "gitbook", "password": "reader-secret"},
        )
        self.assertTrue(share_info["enabled"])
        self.assertEqual(share_info["slug"], "public-guide-v24")
        self.assertTrue(share_info["hasPassword"])
        self.assertEqual(len(list_public_shares(self.vault_a)), 1)

        # Lock the vault completely — public snapshot must still be readable WITHOUT unlocking private vault!
        self.vault_a.lock()
        snapshot = fetch_public_snapshot(self.vault_a, "public-guide-v24")
        self.assertIsNotNone(snapshot)
        assert snapshot is not None

        # Password verification & cookie signing
        self.assertFalse(verify_share_password(snapshot["password_hash"], "wrong-pass"))
        self.assertTrue(verify_share_password(snapshot["password_hash"], "reader-secret"))
        cookie = make_unlock_cookie("server-secret", snapshot["slug"], snapshot["password_hash"])
        self.assertTrue(verify_unlock_cookie("server-secret", snapshot["slug"], snapshot["password_hash"], cookie))
        self.assertFalse(verify_unlock_cookie("server-secret", snapshot["slug"], snapshot["password_hash"], "forged"))

        # Locked HTML must not expose note body
        locked_html = render_public_page_html(snapshot, locked=True).decode("utf-8")
        self.assertIn("Unlock note", locked_html)
        self.assertNotIn("x_24 = 24", locked_html)

        # Unlocked HTML renders GitBook TOC, collapsible 25-line code block, escapes XSS, and leaks NO secret content
        unlocked_html = render_public_page_html(snapshot, locked=False).decode("utf-8")
        self.assertIn("On this page", unlocked_html)
        self.assertIn("PYTHON · 25 lines", unlocked_html)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", unlocked_html)
        self.assertNotIn("<script>alert(1)</script>", unlocked_html)
        self.assertNotIn("TOP SECRET PRIVATE CONTENT", unlocked_html)
        self.assertIn("Secret Vault Note", unlocked_html)
        self.assertNotIn("[[Secret Vault Note]]", unlocked_html)

        # Re-unlock vault and unpublish -> snapshot immediately deleted
        self.vault_a.unlock("account-a-strong-pass!", create=False)
        off = configure_note_share(self.vault_a, public_id, {"enabled": False})
        self.assertFalse(off["enabled"])
        self.assertIsNone(fetch_public_snapshot(self.vault_a, "public-guide-v24"))

    def test_static_html_and_public_site_bundle_export(self) -> None:
        import base64
        import hashlib
        import re
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        ids = self.vault_a.create_notes([
            {"title": "Static Public Note", "body": "# Welcome\n\nVisible static body.", "tags": ["Public"]},
            {"title": "Hidden Private Note", "body": "NEVER_IN_STATIC_BUNDLE", "tags": ["Private"]},
        ])
        pub_id = ids[0]
        configure_note_share(self.vault_a, pub_id, {"enabled": True, "slug": "static-demo", "theme": "paper"})

        # 1. Plain static HTML export
        fname, plain_bytes = export_static_public_html(self.vault_a, pub_id)
        self.assertEqual(fname, "static-demo.html")
        self.assertIn(b"Visible static body.", plain_bytes)
        self.assertNotIn(b"NEVER_IN_STATIC_BUNDLE", plain_bytes)

        # 2. Password-protected AES-256-GCM static HTML export (zero plaintext in file)
        enc_name, enc_bytes = export_static_public_html(self.vault_a, pub_id, static_password="my-static-key")
        self.assertEqual(enc_name, "static-demo.html")
        self.assertNotIn(b"Visible static body.", enc_bytes)
        match = re.search(rb'<script id="xotira-payload" type="application/json">(.*?)</script>', enc_bytes)
        self.assertIsNotNone(match)
        assert match is not None
        payload = json.loads(match.group(1).decode("utf-8"))
        key = hashlib.pbkdf2_hmac("sha256", b"my-static-key", base64.b64decode(payload["salt"]), payload["iter"], dklen=32)
        decrypted = AESGCM(key).decrypt(
            base64.b64decode(payload["iv"]),
            base64.b64decode(payload["ct"]),
            b"Xotira/static-public/1",
        )
        self.assertEqual(decrypted, plain_bytes)

        # 3. Static public site bundle ZIP (ONLY published notes + _headers + 404.html)
        site_zip, count = export_static_public_site_zip(self.vault_a)
        self.assertEqual(count, 1)
        self.assertNotIn(b"NEVER_IN_STATIC_BUNDLE", site_zip)
        with ZipFile(io.BytesIO(site_zip)) as archive:
            self.assertEqual(set(archive.namelist()), {"p/static-demo/index.html", "404.html", "_headers"})


if __name__ == "__main__":
    unittest.main()
