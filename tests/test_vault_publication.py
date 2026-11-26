import errno
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from vault import Vault, VaultError, publish_exclusive


class ExclusivePublicationTests(unittest.TestCase):
    def test_android_without_hard_links_creates_and_backs_up_valid_vault(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            current = root / "source.xotira"
            backup = root / "backup.xotira"
            password = "test-only password 1234"
            with patch("vault.os.link", side_effect=PermissionError(errno.EACCES, "hard links denied")):
                vault = Vault(current)
                vault.unlock(password, create=True)
                vault.backup(backup)
                vault.lock()
                vault.unlock(password, create=False)
                Vault(backup).unlock(password, create=False)
                original = backup.read_bytes()
                with self.assertRaises(FileExistsError):
                    vault.backup(backup)
                self.assertEqual(backup.read_bytes(), original)
                with self.assertRaises(VaultError):
                    Vault(current).unlock(password, create=True)
                self.assertFalse(list(root.glob(".new-*")))
                self.assertFalse(list(root.glob(".snapshot-*")))

    def test_failed_rename_cleans_reservation_without_destroying_source(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "tmp"
            destination = Path(directory) / "new"
            source.write_bytes(b"complete contents")
            with patch("vault.os.link", side_effect=PermissionError(errno.EACCES, "denied")), \
                    patch("vault.os.replace", side_effect=OSError(errno.EIO, "write failed")):
                with self.assertRaises(OSError):
                    publish_exclusive(source, destination)
            self.assertFalse(destination.exists())
            self.assertEqual(source.read_bytes(), b"complete contents")
