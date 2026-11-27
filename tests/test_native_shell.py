import json
import tempfile
import unittest
from pathlib import Path
from threading import Thread
from urllib.request import Request, urlopen
from unittest.mock import patch

from app import Server
from native_shell import NativeWindowError, external_url, local_origin, run_window
from vault import Vault


class NativeWindowTests(unittest.TestCase):
    def test_only_permitted_local_origin_and_external_web_links(self):
        self.assertEqual(local_origin("http://127.0.0.1:5270/#fixture"), "http://127.0.0.1:5270")
        for address in ("https://127.0.0.1:5270", "http://example.com:5270", "http://127.0.0.1", "http://user@127.0.0.1:5270"):
            with self.assertRaises(NativeWindowError):
                local_origin(address)
        self.assertTrue(external_url("https://example.org/page"))
        for address in ("file:///private/file", "javascript:alert(1)", "https://user@example.org"):
            self.assertFalse(external_url(address))

    def test_native_launch_selects_window_without_opening_browser(self):
        url = "http://127.0.0.1:5270/#fixture"
        with patch("native_shell.sys.platform", "linux"), patch("native_shell._run_qt") as qt:
            run_window(url)
            qt.assert_called_once_with(url, "http://127.0.0.1:5270", None, None)
        with patch("native_shell.sys.platform", "win32"), patch("native_shell._run_platform_webview") as native:
            run_window(url)
            native.assert_called_once_with(url, None, None)

    def test_close_requires_authenticated_editor_save_confirmation(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Vault(Path(directory) / "close-test.xotira")
            with Server(vault, None) as server:
                server.telemetry.endpoint = ""
                thread = Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    self.assertTrue(server.prepare_native_close(lambda _: self.fail("locked vault has no edits")))
                    vault.unlock("disposable-native-close-password", create=True)

                    def reply(ok):
                        def trigger(script):
                            self.assertIn("memoryMapPrepareClose", script)
                            request = Request(server.origin + "/api/native-close-ready", data=json.dumps({"ok": ok}).encode(),
                                              headers={"Authorization": "Bearer " + server.token, "Origin": server.origin,
                                                       "Content-Type": "application/json"})
                            with urlopen(request, timeout=5) as response:
                                self.assertEqual(response.status, 200)
                        return trigger

                    self.assertFalse(server.prepare_native_close(reply(False)))
                    self.assertTrue(server.prepare_native_close(reply(True)))
                    self.assertFalse(server.native_close_pending)
                finally:
                    server.shutdown()
                    thread.join(timeout=5)
                    vault.lock()
