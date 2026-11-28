"""Exercise the real desktop WebView (not a browser) with a disposable vault."""
from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import time
from pathlib import Path
from threading import Thread
from urllib.request import Request, urlopen
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import Server
from account_fixture import fixture_account
from native_shell import run_window
from vault import Vault

PASSWORD = "disposable-native-window-password"
TITLE = "Native window smoke note"
FINAL_TITLE = "Native window edit saved on close"
UI_TEST = f"""
(() => {{
    let step = 0;
    const timer = setInterval(() => {{
        if (step === 0 && document.querySelector('#password:enabled')) {{
            document.getElementById('password').value = {json.dumps(PASSWORD)};
            document.getElementById('confirmation').value = {json.dumps(PASSWORD)};
            document.getElementById('unlock-button').click();
            step = 1;
        }} else if (step === 1 && document.querySelector('#workspace:not([hidden])')) {{
            document.getElementById('create-note').click();
            step = 2;
        }} else if (step === 2 && document.querySelector('#create-dialog[open]')) {{
            document.getElementById('new-title').value = {json.dumps(TITLE)};
            document.getElementById('create-form').requestSubmit();
            clearInterval(timer);
        }}
    }}, 100);
}})()
"""


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="memorymap-native-smoke-") as directory:
        vault = Vault(Path(directory) / "fixture.xotira")
        with Server(vault, None, account=fixture_account()) as server:
            server.telemetry.endpoint = ""
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            started = False
            passed = False
            deadline = time.monotonic() + 65

            download_path = Path(directory) / "native-save.xotira"

            def backup_complete() -> bool:
                if not download_path.exists() or download_path.stat().st_size < 4096:
                    return False
                try:
                    with sqlite3.connect(download_path.as_uri() + "?mode=ro", uri=True) as db:
                        return db.execute("PRAGMA quick_check").fetchone() == ("ok",)
                except sqlite3.Error:
                    return False

            def note_exists(title=TITLE) -> bool:
                try:
                    request = Request(server.origin + "/api/graph", headers={"Authorization": "Bearer " + server.token})
                    with urlopen(request, timeout=2) as response:
                        return any(note.get("title") == title for note in json.load(response)["nodes"])
                except Exception:
                    return False

            def start_test(window):
                nonlocal started, passed
                if started:
                    return
                started = True
                if sys.platform.startswith("linux"):
                    from PySide6.QtCore import QTimer
                    window.page().runJavaScript(UI_TEST)
                    timer = QTimer(window)
                    downloading = False
                    editing = False

                    def close_after_edit(edited):
                        nonlocal passed, editing
                        editing = False
                        if edited:
                            passed = True
                            timer.stop()
                            window.window().close()

                    def poll():
                        nonlocal downloading, editing
                        if time.monotonic() >= deadline:
                            timer.stop()
                            window.window().close()
                            return
                        if not note_exists():
                            return
                        if not downloading:
                            downloading = True
                            window.page().runJavaScript("document.getElementById('backup').click()")
                        if not editing and backup_complete():
                            editing = True
                            window.page().runJavaScript("(() => { const title=document.getElementById('title'); " +
                                "if(!title || title.value!==" + json.dumps(TITLE) + ") return false; title.value=" +
                                json.dumps(FINAL_TITLE) + "; title.dispatchEvent(new Event('input',{bubbles:true})); return true; })()",
                                close_after_edit)
                    timer.timeout.connect(poll)
                    timer.start(100)
                else:
                    window.run_js(UI_TEST)
                    while time.monotonic() < deadline:
                        if note_exists():
                            passed = True
                            break
                        time.sleep(0.25)
                    window.destroy()

            try:
                if sys.platform.startswith("linux"):
                    from PySide6.QtWidgets import QFileDialog
                    with patch.object(QFileDialog, "getSaveFileName", return_value=(str(download_path), "")):
                        run_window(server.origin + "/#" + server.token, loaded=start_test, prepare_close=server.prepare_native_close)
                    assert backup_complete(), "Native backup download was not completed"
                    assert TITLE.encode() not in download_path.read_bytes(), "Downloaded backup is not encrypted"
                    restored = Vault(download_path)
                    restored.unlock(PASSWORD, create=False)
                    assert any(note.get("title") == TITLE for note in restored.graph()["nodes"])
                    restored.lock()
                    assert note_exists(FINAL_TITLE), "The pending edit was not saved on native close"
                else:
                    run_window(server.origin + "/#" + server.token, loaded=start_test, prepare_close=server.prepare_native_close)
                assert started and passed, "Native workspace did not create a note through its real UI"
                assert TITLE.encode() not in vault.path.read_bytes(), "Note title must stay encrypted"
                print("PASS native window loaded, created encrypted vault and note, and closed after save confirmation", flush=True)
            finally:
                server.shutdown()
                thread.join(timeout=5)
                vault.lock()


if __name__ == "__main__":
    main()
