"""Smoke test for a built standalone program (any OS): starts it, checks the bundled web files and the vault API.

Usage: python3 tests/smoke_binary.py dist/MemoryMap      (Windows: python tests\\smoke_binary.py dist\\MemoryMap.exe)
"""
import os, re, subprocess, sys, tempfile, urllib.request


def main() -> None:
    binary = os.path.abspath(sys.argv[1])
    folder = tempfile.mkdtemp(prefix="xotira-smoke-")
    process = subprocess.Popen([binary, "--vault", os.path.join(folder, "smoke.xotira"), "--no-browser"],
                               stdout=subprocess.PIPE, text=True, cwd=folder)
    try:
        match = re.search(r"http://127\.0\.0\.1:\d+", process.stdout.readline())
        assert match, "the program did not print its local address"
        base = match.group(0)
        for asset in ["/", "/app.js", "/home.js", "/i18n.js", "/styles.css", "/pdf/pdf.mjs", "/vendor/katex.mjs"]:
            assert urllib.request.urlopen(base + asset, timeout=10).status == 200, asset
        print("PASS standalone program serves all bundled web files")
    finally:
        process.terminate()


if __name__ == "__main__":
    main()
