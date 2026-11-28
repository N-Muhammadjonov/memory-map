"""Launch the installed macOS .app via LaunchServices with an isolated test vault."""
from __future__ import annotations

import re
import os
import plistlib
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.request import urlopen


def main() -> None:
    from AppKit import NSRunningApplication
    from Quartz import CGWindowListCopyWindowInfo, kCGWindowListOptionAll, kCGNullWindowID

    bundle = Path(sys.argv[1]).resolve()
    assert bundle.is_dir() and bundle.suffix == ".app"
    assert any(p.is_file() for p in (bundle/"Contents").rglob("cacert.pem")), "Missing CA bundle in installed macOS app"
    with (bundle/"Contents"/"Info.plist").open("rb") as stream:
        executable = bundle/"Contents"/"MacOS"/plistlib.load(stream)["CFBundleExecutable"]
    with tempfile.TemporaryDirectory(prefix="memorymap-auth-health-") as ca_folder:
        env = {**os.environ, "SSL_CERT_FILE": str(Path(ca_folder)/"missing-ca.pem"),
               "SSL_CERT_DIR": str(Path(ca_folder)/"missing-cert-dir")}
        subprocess.run([str(executable), "--check-auth-service"], env=env, check=True, timeout=35)
        print("PASS: installed macOS app verified live Google HTTPS without build-host CA paths")
    bundle_id = "com.memorymap.app"
    existing = {int(app.processIdentifier()) for app in NSRunningApplication.runningApplicationsWithBundleIdentifier_(bundle_id)}
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix="memorymap-bundle-launch-") as folder:
        base = Path(folder)
        stdout, stderr = base / "stdout.log", base / "stderr.log"
        process = None
        try:
            subprocess.run(["open", "-n", "-a", str(bundle), "--stdout", str(stdout), "--stderr", str(stderr),
                            "--args", "--vault", str(base / "launch-test.xotira"), "--port", str(port)], check=True, timeout=25)
            deadline = time.monotonic() + 85
            while time.monotonic() < deadline:
                apps = NSRunningApplication.runningApplicationsWithBundleIdentifier_(bundle_id)
                process = next((app for app in apps if int(app.processIdentifier()) not in existing), process)
                if process and not process.isTerminated():
                    pid = int(process.processIdentifier())
                    windows = CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID) or []
                    visible = any(int(w.get("kCGWindowOwnerPID", -1)) == pid and int(w.get("kCGWindowLayer", -1)) == 0
                                  and float(w.get("kCGWindowBounds", {}).get("Width", 0)) > 100
                                  and float(w.get("kCGWindowBounds", {}).get("Height", 0)) > 100 for w in windows)
                    if visible:
                        try:
                            with urlopen(f"http://127.0.0.1:{port}/", timeout=2) as response:
                                body = response.read()
                                if response.status == 200 and b"Memory map" in body:
                                    print("PASS: copied macOS bundle opened by LaunchServices, native window visible, loopback workspace served")
                                    return
                        except OSError:
                            pass
                time.sleep(0.5)
            raise AssertionError("The copied app did not open a native window through LaunchServices")
        except Exception:
            for path in (stdout, stderr):
                if path.exists():
                    text = re.sub(r"http://127\.0\.0\.1:\d+/#\S+", "[local launch URL omitted]", path.read_text(errors="replace"))
                    print(path.name, text[-2000:])
            raise
        finally:
            if process and not process.isTerminated():
                process.terminate()
                deadline = time.monotonic() + 8
                while not process.isTerminated() and time.monotonic() < deadline:
                    time.sleep(0.2)
                if not process.isTerminated():
                    process.forceTerminate()


if __name__ == "__main__":
    main()
