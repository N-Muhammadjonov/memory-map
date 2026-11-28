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
from urllib.parse import parse_qs, urlsplit
from urllib.error import HTTPError

PASSWORD = "disposable-binary-smoke-password"


def main() -> None:
    binary = os.path.abspath(sys.argv[1])
    with tempfile.TemporaryDirectory(prefix="memorymap-smoke-") as folder:
        path = Path(folder) / "smoke.xotira"
        # Reproduce the missing build-machine CA file on an end-user system.
        # The release must work with its own trust store, not a runner's OpenSSL.
        env = {**os.environ, "SSL_CERT_FILE": str(Path(folder)/"missing-ca.pem"),
               "SSL_CERT_DIR": str(Path(folder)/"missing-cert-dir")}
        process = subprocess.Popen([binary, "--vault", str(path), "--no-browser"],
                                   stdout=subprocess.PIPE, text=True, cwd=folder, env=env)
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

            for asset in ["/", "/app.js", "/home.js", "/i18n.js", "/inline-format.js", "/styles.css", "/pdf/pdf.mjs", "/vendor/katex.mjs", "/assets/memory-map.svg", "/assets/memory-map-192.png", "/assets/memory-map-512.png"]:
                assert request(asset)[0] == 200, asset
            state = json.loads(request("/api/status")[1])
            assert state["unlocked"] is False and state["authenticated"] is False
            # Real live provider settings, with certificate validation intact.
            account = json.loads(request("/api/account")[1])
            assert account["configured"] is True and account["googleAvailable"] is True, "Bundled HTTPS connection to Google auth settings failed"
            callback = parse_qs(urlsplit(state["googleLogin"]["url"]).query)["redirect_to"][0]
            # A deliberately invalid fixture code must reach Supabase and be
            # rejected as a code, not fail due to missing CA or a transport error.
            status, response = request(callback.removeprefix(base) + "&code=invalid-release-smoke-fixture")
            assert status == 200 and b"Sign-in could not finish" in response
            retry = json.loads(request("/api/status")[1])
            assert not retry["authenticated"] and retry["googleLogin"]["url"] != state["googleLogin"]["url"]
            assert "code" in retry["googleLogin"]["message"].lower(), retry["googleLogin"]["message"]
            print("PASS bundled HTTPS Google settings and token endpoint rejection with missing system CA files")
            for route, body in [("/api/create", {"password": PASSWORD}), ("/api/unlock", {"password": PASSWORD}), ("/api/notes", None), ("/api/voice", {"action": "start", "id": "0"*36, "language": "en"})]:
                try:
                    request(route, body)
                    raise AssertionError("Unauthenticated workspace request succeeded: " + route)
                except HTTPError as error:
                    assert error.code == 401, (route, error.code)
            assert not path.exists(), "guest must not create a vault"
            print("PASS bundled resources and mandatory Google sign-in gate")

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
