from hashlib import sha256
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from account_auth import AccountClient
from update_manager import UpdateManager, asset_name, release_asset
from vault import VaultError


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.name = asset_name("darwin", "arm64")
        self.repo = "owner/memory-map"
        self.binary = b"public test binary"
        self.data = {"tag_name": "v38", "draft": False, "prerelease": False, "assets": [{
            "name": self.name, "state": "uploaded", "size": len(self.binary),
            "digest": "sha256:" + sha256(self.binary).hexdigest(),
            "browser_download_url": f"https://github.com/{self.repo}/releases/download/v38/{self.name}"
        }]}

    def test_release_is_specific_to_platform_repository_and_hash(self):
        self.assertIsNotNone(release_asset(self.data, self.repo, "v37", self.name))
        self.assertIsNone(release_asset(self.data, self.repo, "v38", self.name))
        self.assertIsNone(release_asset(self.data, self.repo, "v37", "MemoryMap-windows-x64.exe"))
        self.data["assets"][0]["browser_download_url"] = "https://example.invalid/file"
        self.assertIsNone(release_asset(self.data, self.repo, "v37", self.name))

    def test_opt_in_verified_staging_and_tamper_rejection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def download(asset, path):
                path.parent.mkdir(parents=True)
                path.write_bytes(self.binary)
            mgr = UpdateManager(root, self.repo, "v37", name=self.name,
                                fetch=lambda _: self.data, download=download)
            self.assertFalse(mgr.status()["enabled"])
            self.assertFalse(mgr.launch_pending([]))
            mgr.config["enabled"] = True
            mgr._stage()
            self.assertEqual(mgr.status()["staged"], "v38")
            with patch("update_manager.subprocess.Popen") as popen:
                self.assertTrue(mgr.launch_pending(["--vault", "/test/vault.xotira"]))
                self.assertEqual(popen.call_args.args[0][1:], ["--vault", "/test/vault.xotira"])
            (root/"v38"/self.name).write_bytes(b"tampered")
            with patch("update_manager.subprocess.Popen") as popen:
                self.assertFalse(mgr.launch_pending([]))
                popen.assert_not_called()

    def test_no_release_for_prerelease_or_missing_digest(self):
        self.data["prerelease"] = True
        self.assertIsNone(release_asset(self.data, self.repo, "v37", self.name))
        self.data["prerelease"] = False
        self.data["assets"][0].pop("digest")
        self.assertIsNone(release_asset(self.data, self.repo, "v37", self.name))


class AccountTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.result = {"user": {"id": "synthetic-user", "email": "test@example.invalid",
                                "email_confirmed_at": "2026-01-01"}, "access_token": "synthetic-token"}
        def transport(path, data, token=""):
            self.calls.append((path, data, token))
            return self.result
        self.account = AccountClient("https://project.supabase.co", "sb_publishable_test",
                                     "https://example.invalid/account-confirmed.html", transport=transport)

    def test_registration_requires_confirmation_and_tokens_are_private(self):
        result = self.account.email("test@example.invalid", "test-password-12", register=True)
        self.assertFalse(result["user"])
        self.assertTrue(self.calls[0][0].startswith("signup?"))
        self.result["user"].pop("email_confirmed_at")
        with self.assertRaises(VaultError):
            self.account.email("test@example.invalid", "test-password-12", register=False)
        self.result["user"]["email_confirmed_at"] = "2026-01-01"
        result = self.account.email("test@example.invalid", "test-password-12", register=False)
        self.assertEqual(result["user"]["email"], "test@example.invalid")
        self.assertNotIn("synthetic-token", str(result))
        self.account.sign_out()
        self.assertFalse(self.account.status()["user"])

    def test_google_pkce_nonce_is_single_use(self):
        url = self.account.begin_google("http://127.0.0.1:12345")
        parameters = parse_qs(urlsplit(url).query)
        self.assertEqual(parameters["provider"], ["google"])
        nonce = parse_qs(urlsplit(parameters["redirect_to"][0]).query)["nonce"][0]
        with self.assertRaises(VaultError):
            self.account.finish_google("wrong", "code")
        self.assertTrue(self.account.finish_google(nonce, "code"))
        self.assertTrue(self.calls[-1][1]["code_verifier"])
        with self.assertRaises(VaultError):
            self.account.finish_google(nonce, "code")

    def test_rejects_unsafe_configuration(self):
        self.assertFalse(AccountClient("http://project.supabase.co","sb_publishable_test","").configured)
        self.assertFalse(AccountClient("https://project.supabase.co","service_role_secret","").configured)
