"""v27: the download page picks the right file for the visitor (GitHub API is mocked)."""
import json, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

SITE = Path(__file__).resolve().parents[2] / "site" / "index.html"
RELEASE = {"tag_name": "v27", "assets": [
    {"name": "Memory map-windows.exe", "size": 18_000_000, "browser_download_url": "https://github.com/OWNER/REPO/releases/download/v27/Memory map-windows.exe"},
    {"name": "Memory map-macos.tar.gz", "size": 17_000_000, "browser_download_url": "https://github.com/OWNER/REPO/releases/download/v27/Memory map-macos.tar.gz"},
    {"name": "Memory map-linux.tar.gz", "size": 17_500_000, "browser_download_url": "https://github.com/OWNER/REPO/releases/download/v27/Memory map-linux.tar.gz"},
    {"name": "evil.exe", "size": 1, "browser_download_url": "https://evil.example/evil.exe"}]}


def main():
    failures = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for agent, expect in [("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120", "Windows"),
                              ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120", "macOS"),
                              ("Mozilla/5.0 (X11; Linux x86_64) Chrome/120", "Linux")]:
            page = browser.new_context(user_agent=agent).new_page()
            page.route("https://api.github.com/**", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(RELEASE)))
            page.goto(SITE.as_uri())
            page.wait_for_function("document.querySelector('#main-download').textContent.startsWith('Download for')")
            if page.locator("#main-download").inner_text() != f"Download for {expect}":
                failures.append(f"{expect}: {page.locator('#main-download').inner_text()}")
            hrefs = page.locator("#all a").evaluate_all("els => els.map(e => e.href)")
            if len(hrefs) != 3 or any("evil" in h for h in hrefs):
                failures.append(f"{expect}: unexpected links {hrefs}")
            page.close()
        page = browser.new_page()
        page.route("https://api.github.com/**", lambda route: route.fulfill(status=404, body="{}"))
        page.goto(SITE.as_uri())
        page.wait_for_function("document.querySelector('#main-download').textContent === 'Go to downloads'")
        browser.close()
    if failures:
        print("FAIL\n" + "\n".join(failures)); sys.exit(1)
    print("PASS v27 download page (Windows, macOS, Linux, missing release)")


if __name__ == "__main__":
    main()
