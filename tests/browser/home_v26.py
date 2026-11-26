"""v26 real-browser check of the first-run experience: password warning, Home, checklist, language, no overflow.

Run: python3 tests/browser/home_v26.py
"""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from layout_v23 import boot  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

PASSWORD = "a-fresh-tester-password-1"


def main():
    failures = []
    for label, viewport in [("desktop", {"width": 1280, "height": 800}), ("phone", {"width": 390, "height": 844}),
                            ("phone-landscape", {"width": 844, "height": 390})]:
        proc, url = boot(seed=False)
        try:
            with sync_playwright() as pw:
                browser = pw.chromium.launch()
                page = browser.new_page(viewport=viewport, has_touch=viewport["width"] < 900)
                errors = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.on("console", lambda m: errors.append(m.text[:160]) if m.type == "error" else None)
                page.goto(url)
                page.locator("#password:enabled").wait_for()
                if "cannot be recovered" not in page.locator(".gate-warning").inner_text():
                    failures.append(f"{label}: password-loss warning missing")
                page.fill("#password", PASSWORD)
                page.fill("#confirmation", PASSWORD)
                page.click("#unlock-button")
                page.wait_for_selector("#workspace:not([hidden])")
                page.wait_for_selector("#home-panel .home-page")
                if not page.locator("#home-panel").is_visible() or page.locator("#map-panel").is_visible():
                    failures.append(f"{label}: first screen is not Home")
                if "0/3" not in page.locator(".home-start h3").inner_text():
                    failures.append(f"{label}: checklist should start at 0/3")
                page.locator(".home-start .home-action").click()
                page.locator("#home-panel .home-note-row").first.wait_for()
                if "2/3" not in page.locator(".home-start h3").inner_text() and "1/3" not in page.locator(".home-start h3").inner_text():
                    failures.append(f"{label}: checklist did not advance after sample notes")
                page.locator(".home-actions .primary").click()  # New note proxies the sidebar button
                page.locator("#create-dialog[open] #new-title").fill("My first real note")
                page.locator("#create-form button[type=submit]").click()
                page.wait_for_selector("#reading-panel:not([hidden])")
                page.locator("#nav-home").click() if page.locator("#nav-home").is_visible() else (
                    page.locator("#toggle-sidebar").click(), page.locator("#nav-home").click())
                page.wait_for_selector("#home-panel .home-page")
                overflow = page.evaluate("document.documentElement.scrollWidth - innerWidth")
                if overflow > 1:
                    failures.append(f"{label}: Home overflows by {overflow}px")
                page.locator("#lang-select").select_option("uz", force=True)
                if "Xayrli" not in page.locator(".home-greeting").inner_text():
                    failures.append(f"{label}: Home did not switch to Uzbek")
                if errors:
                    failures.append(f"{label}: errors {errors}")
                browser.close()
        finally:
            proc.terminate()
    if failures:
        print("FAIL\n" + "\n".join(failures))
        sys.exit(1)
    print("PASS v26 first-run Home (desktop, phone, phone-landscape)")


if __name__ == "__main__":
    main()
