"""v27: the download page picks the right file for the visitor (GitHub API is mocked)."""
import json, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

SITE = Path(__file__).resolve().parents[2] / "site" / "index.html"
REPO = "N-Muhammadjonov/memory-map"
NAMES = ["MemoryMap-windows-x64.exe", "MemoryMap-macos-arm64.dmg", "MemoryMap-macos-x64.dmg",
         "MemoryMap-linux-x64.tar.gz", "MemoryMap-linux-arm64.tar.gz", "MemoryMap-android.apk"]
RELEASE = {"tag_name": "v44", "assets": [
    {"name": name, "size": 18_000_000, "state": "uploaded", "digest": "sha256:" + "a" * 64,
     "browser_download_url": f"https://github.com/{REPO}/releases/download/v44/{name}"}
    for name in NAMES] + [{"name": "evil.exe", "size": 1, "state": "uploaded", "digest": "sha256:" + "a" * 64,
                            "browser_download_url": "https://evil.example/evil.exe"}]}


def main():
    failures = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for agent, expect in [("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120", "Windows"),
                              ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120", "Choose your Mac chip"),
                              ("Mozilla/5.0 (X11; Linux x86_64) Chrome/120", "Linux")]:
            page = browser.new_context(user_agent=agent).new_page()
            page.route("https://api.github.com/**", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(RELEASE)))
            page.goto(SITE.as_uri())
            page.wait_for_function("document.querySelector('#release-status').textContent.startsWith('Latest release')")
            label = expect if expect == "Choose your Mac chip" else f"Download for {expect}"
            if page.locator("#main-download").inner_text() != label:
                failures.append(f"{expect}: {page.locator('#main-download').inner_text()}")
            if expect == "Choose your Mac chip":
                assert page.locator("#macos-download a:visible").count() == 0
                page.locator("#macos-chip").select_option("arm64")
                assert page.locator("#macos-download a:visible").count() == 1
                assert page.locator("#macos-download a").get_attribute("href").endswith("MemoryMap-macos-arm64.dmg")
                requests = []
                def download(route):
                    requests.append(route.request.url)
                    route.fulfill(status=200, content_type="application/octet-stream", headers={"Content-Disposition":"attachment; filename=MemoryMap-macos-arm64.dmg"}, body="synthetic fixture")
                page.route("**/MemoryMap-macos-arm64.dmg", download)
                with page.expect_download() as accepted:
                    page.locator("#macos-download a").dblclick()
                assert accepted.value.suggested_filename == "MemoryMap-macos-arm64.dmg"
                assert len(requests) == 1, requests
                assert page.locator("#macos-download a").get_attribute("aria-disabled") == "true"
                assert page.locator("#macos-download .download-retry").is_visible()
                page.locator("#macos-download .download-retry").click()
                assert page.locator("#macos-download a").get_attribute("aria-disabled") is None
                assert len(requests) == 1, "Enabling retry must not start another download"
                page.locator("#macos-chip").select_option("x64")
                assert page.locator("#macos-download a:visible").count() == 1
                assert page.locator("#macos-download a").get_attribute("href").endswith("MemoryMap-macos-x64.dmg")
            hrefs = page.locator("#all a:visible").evaluate_all("els => els.map(e => e.href)")
            expected_count = 5 if expect == "Choose your Mac chip" else 4
            if len(hrefs) != expected_count or any("evil" in h for h in hrefs):
                failures.append(f"{expect}: unexpected links {hrefs}")
            page.close()
        page = browser.new_page()
        page.route("https://api.github.com/**", lambda route: route.fulfill(status=404, body="{}"))
        page.goto(SITE.as_uri())
        page.wait_for_function("document.querySelector('#release-status').textContent.startsWith('No public release')")
        browser.close()
    if failures:
        print("FAIL\n" + "\n".join(failures)); sys.exit(1)
    print("PASS v27 download page (Windows, macOS, Linux, missing release)")


if __name__ == "__main__":
    main()
