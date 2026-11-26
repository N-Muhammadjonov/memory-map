"""v26: the vault lock must work without fcntl (Windows). A fake msvcrt stands in for the Windows API."""

from __future__ import annotations

import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import vault as vault_module
from vault import Vault, VaultError


class WindowsLockTests(unittest.TestCase):
    def test_lock_uses_msvcrt_when_fcntl_is_missing(self) -> None:
        held: set[int] = set()
        calls: list[str] = []

        def locking(descriptor: int, mode: int, size: int) -> None:
            if mode == 1:  # LK_NBLCK
                if held:
                    raise OSError("locked")
                held.add(descriptor)
                calls.append("lock")
            else:  # LK_UNLCK
                held.discard(descriptor)
                calls.append("unlock")

        fake = types.SimpleNamespace(LK_NBLCK=1, LK_UNLCK=0, locking=locking)
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(vault_module, "fcntl", None), \
                mock.patch.object(vault_module, "msvcrt", fake, create=True):
            first = Vault(Path(folder) / "a.xotira")
            second = Vault(Path(folder) / "a.xotira")
            with first.process_lock():
                with self.assertRaises(VaultError):
                    with second.process_lock():
                        pass
            with second.process_lock():  # released after the first holder left
                pass
        self.assertEqual(calls, ["lock", "unlock", "lock", "unlock"])

    def test_default_vault_folder_on_windows(self) -> None:
        import app
        with mock.patch.object(app.sys, "platform", "win32"), mock.patch.dict(app.os.environ, {"APPDATA": r"C:\Users\x\AppData\Roaming"}):
            self.assertEqual(app.default_vault().name, "Xotira.xotira")
            self.assertEqual(app.default_vault().parent.name, "Xotira")


if __name__ == "__main__":
    unittest.main()
