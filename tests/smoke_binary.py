"""Exercise a standalone release binary against an isolated local vault.

Usage: python tests/smoke_binary.py dist/MemoryMap[.exe]
"""
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.request import Request, urlopen

PASSWORD = "disposable-binary-smoke-password"


def main() -> None:
    binary = os.path.abspath(sys.argv[1])
    with tempfile.TemporaryDirectory(prefix="memorymap-smoke-") as folder:
        path = Path(folder) / "smoke.xotira"
        process = subprocess.Popen([binary, "--vault", str(path), "--no-browser"],
                                   stdout=subprocess.PIPE, text=True, cwd=folder)
        try:
            match = re.search(r"(http://127\.0\.0\.1:\d+)/#([A-Za-z0-9_-]+)", process.stdout.readline())
            assert match, "the program did not print its local address"
            base, token = match.groups()

            def request(route, body=None):
                headers = {"Authorization": f"Bearer {token}"}
                if body is not None:
                    headers.update({"Origin": base, "Content-Type": "application/json"})
                request = Request(base + route, headers=headers,
                                  data=json.dumps(body).encode() if body is not None else None)
                with urlopen(request, timeout=20) as response:
                    return response.status, response.read()

            for asset in ["/", "/app.js", "/home.js", "/i18n.js", "/styles.css", "/pdf/pdf.mjs", "/vendor/katex.mjs"]:
                assert request(asset)[0] == 200, asset
            assert json.loads(request("/api/status")[1])["unlocked"] is False
            assert json.loads(request("/api/create", {"password": PASSWORD})[1])["ok"]
            result = json.loads(request("/api/notes", {"notes": [{"title": "Smoke fixture", "body": "Encrypted binary test"}]})[1])
            route = "/api/notes/" + result["ids"][0]
            assert json.loads(request(route)[1])["body"] == "Encrypted binary test"
            assert b"Encrypted binary test" not in path.read_bytes()
            assert json.loads(request("/api/update-settings")[1])["supported"] is True
            request("/api/lock", {})
            request("/api/unlock", {"password": PASSWORD})
            assert json.loads(request(route)[1])["body"] == "Encrypted binary test"
            print("PASS bundled resources, encrypted vault round trip, and installed update capability")
        finally:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


if __name__ == "__main__":
    main()
