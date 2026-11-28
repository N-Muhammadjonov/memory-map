"""Desktop workspace window; no browser tab is needed for the local vault."""
from __future__ import annotations

import sys
from pathlib import Path
from threading import Thread
from typing import Callable
from urllib.parse import urlsplit

CloseRequest = Callable[[Callable[[str], None]], bool]


class NativeWindowError(RuntimeError):
    """The native workspace could not be started."""


def local_origin(url: str) -> str:
    """Accept only this launch's explicitly bound IPv4 loopback origin."""
    parts = urlsplit(url)
    if parts.scheme != "http" or parts.hostname != "127.0.0.1" or not parts.port or parts.username or parts.password:
        raise NativeWindowError("Invalid local workspace address.")
    return f"http://127.0.0.1:{parts.port}"


def external_url(url: str) -> bool:
    """Only ordinary web links may leave the workspace."""
    try:
        parts = urlsplit(url)
        return parts.scheme in {"http", "https"} and bool(parts.hostname) and not parts.username and not parts.password
    except ValueError:
        return False


def run_window(url: str, *, loaded: Callable | None = None, prepare_close: CloseRequest | None = None) -> None:
    origin = local_origin(url)
    try:
        if sys.platform.startswith("linux"):
            _run_qt(url, origin, loaded, prepare_close)
        else:
            _run_platform_webview(url, loaded, prepare_close)
    except NativeWindowError:
        raise
    except ImportError as exc:
        raise NativeWindowError("Native workspace components are missing. Install requirements-desktop.txt or use the official installer.") from exc
    except Exception as exc:
        raise NativeWindowError("The native workspace could not open. Check that your system WebView is up to date.") from exc


def _require_webview2() -> None:
    import winreg

    runtime = r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        for view in (winreg.KEY_WOW64_32KEY, winreg.KEY_WOW64_64KEY):
            try:
                with winreg.OpenKey(hive, runtime, 0, winreg.KEY_READ | view) as key:
                    version, _ = winreg.QueryValueEx(key, "pv")
                if tuple(map(int, str(version).split("."))) >= (86, 0, 622, 0):
                    return
            except (OSError, ValueError):
                continue
    raise NativeWindowError("Microsoft Edge WebView2 Runtime is required. Install it from https://developer.microsoft.com/microsoft-edge/webview2/ and reopen Memory Map.")


def _run_platform_webview(url: str, loaded: Callable | None, prepare_close: CloseRequest | None) -> None:
    import webview

    if sys.platform == "win32":
        _require_webview2()
    webview.settings.update({
        "ALLOW_DOWNLOADS": True,
        "ALLOW_FILE_URLS": False,
        "OPEN_EXTERNAL_LINKS_IN_BROWSER": True,
        "OPEN_DEVTOOLS_IN_DEBUG": False,
        "IGNORE_SSL_ERRORS": False,
        "REMOTE_DEBUGGING_PORT": None,
    })
    window = webview.create_window("Memory Map", url, width=1250, height=850,
                                   min_size=(360, 450), text_select=True, zoomable=True,
                                   background_color="#18191e")
    if window is None:
        raise NativeWindowError("The desktop window could not be created.")
    if loaded is not None:
        window.events.loaded += lambda: loaded(window)
    if prepare_close is not None:
        closing = False
        allowed = False

        def close_after_save() -> None:
            nonlocal closing, allowed
            try:
                try:
                    allowed = prepare_close(window.run_js)
                except Exception:
                    allowed = False
                if not allowed:
                    allowed = window.create_confirmation_dialog("Memory Map", "The workspace could not confirm saved changes. Close anyway?")
                if allowed:
                    window.destroy()
            finally:
                closing = False

        def on_closing() -> bool:
            nonlocal closing
            if allowed:
                return True
            if not closing:
                closing = True
                Thread(target=close_after_save, daemon=True).start()
            return False

        window.events.closing += on_closing
    # The modern runtime was checked before creating the Windows window.
    webview.start(gui="edgechromium" if sys.platform == "win32" else None,
                  debug=False, private_mode=True)


def _run_qt(url: str, origin: str, loaded: Callable | None, prepare_close: CloseRequest | None) -> None:
    from PySide6.QtCore import QObject, QUrl, Signal
    from PySide6.QtGui import QDesktopServices, QIcon
    from PySide6.QtWidgets import QApplication, QFileDialog, QMainWindow, QMessageBox
    from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineProfile, QWebEngineSettings
    from PySide6.QtWebEngineWidgets import QWebEngineView

    app = QApplication.instance() or QApplication([])
    app.setWindowIcon(QIcon(str(Path(__file__).with_name("web") / "assets" / "memory-map-192.png")))

    class CloseSignals(QObject):
        script = Signal(str)
        completed = Signal(bool)

    class WorkspaceWindow(QMainWindow):
        def __init__(self):
            super().__init__()
            self.closing = False
            self.allowed = False
            self.signals = CloseSignals(self)
            self.signals.completed.connect(self.complete_close)

        def closeEvent(self, event):
            if prepare_close is None or self.allowed:
                event.accept()
                return
            event.ignore()
            if self.closing:
                return
            self.closing = True

            def wait_for_save():
                try:
                    result = prepare_close(self.signals.script.emit)
                except Exception:
                    result = False
                self.signals.completed.emit(result)

            Thread(target=wait_for_save, daemon=True).start()

        def complete_close(self, success):
            self.closing = False
            if not success:
                success = QMessageBox.question(self, "Memory Map", "The workspace could not confirm saved changes. Close anyway?") == QMessageBox.StandardButton.Yes
            if success:
                self.allowed = True
                self.close()

    window = WorkspaceWindow()
    window.setWindowTitle("Memory Map")
    window.resize(1250, 850)
    window.setMinimumSize(360, 450)
    profile = QWebEngineProfile(window)  # off-the-record, no browser profile or shared cookies
    view = QWebEngineView(window)

    class PopupPage(QWebEnginePage):
        def acceptNavigationRequest(self, target, navigation_type, is_main_frame):
            if is_main_frame and external_url(target.toString()):
                QDesktopServices.openUrl(target)
            self.deleteLater()
            return False

    class WorkspacePage(QWebEnginePage):
        def acceptNavigationRequest(self, target, navigation_type, is_main_frame):
            value = target.toString()
            try:
                if local_origin(value) == origin:
                    return True
            except (NativeWindowError, ValueError):
                pass
            if is_main_frame and navigation_type == QWebEnginePage.NavigationType.NavigationTypeLinkClicked and external_url(value):
                QDesktopServices.openUrl(target)
            return False

        def createWindow(self, _window_type):
            return PopupPage(profile, self)

    page = WorkspacePage(profile, view)
    view.setPage(page)

    def microphone_permission(permission):
        # Only this window's loopback origin and only an explicit microphone request.
        from PySide6.QtWebEngineCore import QWebEnginePermission
        if (permission.origin().toString().rstrip("/") == origin and
                permission.permissionType() == QWebEnginePermission.PermissionType.MediaAudioCapture and
                QMessageBox.question(window, "Microphone access", "Allow Memory map to use your microphone for voice dictation?") == QMessageBox.StandardButton.Yes):
            permission.grant()
        else:
            permission.deny()

    page.permissionRequested.connect(microphone_permission)
    window.signals.script.connect(page.runJavaScript)
    settings = page.settings()
    settings.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessFileUrls, False)
    settings.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessRemoteUrls, False)
    settings.setAttribute(QWebEngineSettings.WebAttribute.JavascriptCanOpenWindows, False)
    settings.setAttribute(QWebEngineSettings.WebAttribute.FullScreenSupportEnabled, False)
    window.setCentralWidget(view)

    def save_download(download):
        # Let Chromium supply the download name, not any component of its blob URL.
        name = Path(download.suggestedFileName() or "MemoryMap-download").name
        path, _ = QFileDialog.getSaveFileName(window, "Save file", str(Path.home() / name))
        if not path:
            download.cancel()
            return
        destination = Path(path)
        download.setDownloadDirectory(str(destination.parent))
        download.setDownloadFileName(destination.name)
        download.accept()

    profile.downloadRequested.connect(save_download)
    if loaded is not None:
        page.loadFinished.connect(lambda ok: loaded(view) if ok else None)
    view.setUrl(QUrl(url))
    window.show()
    app.exec()
    # Release the private profile after its page, not before.
    view.setPage(QWebEnginePage(view))
    # PySide owns the old page until it is explicitly disposed.
    from shiboken6 import delete, isValid
    if isValid(page):
        delete(page)
