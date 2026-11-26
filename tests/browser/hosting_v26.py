"""v26 real-browser check: publish one note to a host, open it as a stranger, trash the note, page disappears.

Run: python3 tests/browser/hosting_v26.py
"""
import os, sys, tempfile, threading, urllib.request, urllib.error
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
from layout_v23 import boot, open_workspace  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402
from publish_server import make_server  # noqa: E402
from pathlib import Path  # noqa: E402

KEY = "browser-test-publish-key-123"


def status_of(url):
    try:
        return urllib.request.urlopen(url, timeout=5).status
    except urllib.error.HTTPError as error:
        return error.code


def main():
    host_dir = Path(tempfile.mkdtemp(prefix="xotira-host-"))
    host = make_server("127.0.0.1", 0, host_dir, KEY)
    threading.Thread(target=host.serve_forever, daemon=True).start()
    host_url = f"http://127.0.0.1:{host.server_port}"
    proc, url = boot()
    failures = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            for label, viewport in [("desktop", {"width": 1280, "height": 800}), ("phone-landscape", {"width": 844, "height": 390})]:
                page, errors = open_workspace(browser, url, viewport)
                page.locator("#notes").get_by_role("button", name="Mixed image note", exact=True).click()
                page.wait_for_selector("#share-note")
                page.locator("#share-note").click()
                if not page.locator("#share-enabled").is_checked():
                    page.locator("#share-enabled").check()
                    page.locator("#share-save").click()
                page.wait_for_selector("#host-box", state="attached")
                if page.locator("#host-setup").is_visible():
                    page.fill("#host-url", host_url)
                    page.fill("#host-key", KEY)
                    page.locator("#host-save").scroll_into_view_if_needed()
                    page.locator("#host-save").click()
                page.wait_for_selector("#host-ready", state="visible")
                page.locator("#host-publish").scroll_into_view_if_needed()
                page.locator("#host-publish").click()
                page.wait_for_selector("#host-link", state="visible", timeout=15000)
                link = page.locator("#host-link-url").input_value()
                stranger = browser.new_context().new_page()
                response = stranger.goto(link)
                text = stranger.content()
                if response.status != 200 or "Mixed image note" not in stranger.title():
                    failures.append(f"{label}: hosted page did not open ({response.status})")
                if "Drawing fixtures" in text or "Overflow fixture" in text:
                    failures.append(f"{label}: another note leaked into the hosted page")
                if "script-src 'none'" not in response.headers.get("content-security-policy", ""):
                    failures.append(f"{label}: hosted page allows scripts")
                if errors:
                    failures.append(f"{label}: app errors {errors}")
                page.locator("#share-close").click()
                page.once("dialog", lambda d: d.accept())
                if not page.locator("#remove").is_visible():
                    if not page.locator("#toggle-inspector").is_visible():  # narrow screens keep it in the ··· menu
                        page.locator("#file-menu summary").click()
                    page.locator("#toggle-inspector").click()
                page.locator("#remove").click()
                page.wait_for_timeout(2500)
                if status_of(link) != 404:
                    failures.append(f"{label}: hosted page still online after trashing the note")
                stranger.context.close()
                page.close()
                # fresh vault per viewport: restore the note so the second pass can publish again
                if label == "desktop":
                    proc.terminate()
                    proc, url = boot()
            browser.close()
    finally:
        proc.terminate()
        host.shutdown()
    if failures:
        print("FAIL\n" + "\n".join(failures))
        sys.exit(1)
    print("PASS v26 hosting flow (publish, open as stranger, trash removes it) on desktop and phone-landscape")


if __name__ == "__main__":
    main()
