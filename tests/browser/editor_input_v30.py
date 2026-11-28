"""v30: pressing at the very start of a line keeps focus and selects text; gutter still works; English spell check toggle.

Run: python3 tests/browser/editor_input_v30.py
"""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from layout_v23 import boot  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

PASSWORD = "a-fresh-tester-password-1"
SEL = "() => getSelection().toString()"


def new_note(page, title):
    page.locator(".home-actions .primary").click()
    page.locator("#create-dialog[open] #new-title").fill(title)
    page.locator("#create-form button[type=submit]").click()
    page.locator(".notion-doc").wait_for()
    page.wait_for_timeout(500)


def main():
    proc, url = boot(seed=False)
    failures = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=os.getenv("QA_BROWSER"))
            for label, viewport in [("desktop", {"width": 1280, "height": 800}), ("phone", {"width": 390, "height": 844})]:
                page = browser.new_page(viewport=viewport)
                errors = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(url)
                page.wait_for_timeout(600)
                if page.locator("#password").is_visible():
                    page.locator("#password:enabled").wait_for()
                    page.fill("#password", PASSWORD)
                    if page.locator("#confirmation").is_visible():
                        page.fill("#confirmation", PASSWORD)
                    page.click("#unlock-button")
                page.locator("#home-panel .home-page, #workspace:not([hidden])").first.wait_for()
                page.locator("#nav-home").click() if page.locator("#nav-home").is_visible() else None
                new_note(page, f"Lesson {label}")
                active = page.evaluate("document.activeElement.className")
                if active != "notion-doc":
                    failures.append(f"{label}: a new note does not start with the caret in the editor ({active!r})")
                page.keyboard.type("Cat Dog Elephant lion tiger")
                page.keyboard.press("Enter")
                page.keyboard.type("Second line of text")
                page.wait_for_timeout(300)
                first = page.locator(".notion-doc > p").first.bounding_box()
                y = first["y"] + first["height"] / 2
                # pressing 4px and 10px to the LEFT of the first character, then dragging right
                for offset in (4, 10):
                    page.mouse.click(first["x"] + 5, y + 60)  # move the caret elsewhere first
                    page.mouse.move(first["x"] - offset, y)
                    page.mouse.down()
                    page.mouse.move(first["x"] + 60, y, steps=6)
                    page.mouse.move(first["x"] + 140, y, steps=6)
                    page.mouse.up()
                    page.wait_for_timeout(250)
                    chosen = page.evaluate(SEL)
                    if not chosen.startswith("Cat Dog") or page.evaluate("document.activeElement.className") != "notion-doc":
                        failures.append(f"{label}: drag from {offset}px left of the line start selected {chosen!r}")
                # pressing exactly at the top edge of the editor (above the first line) places the caret in the first line
                top = page.locator("#notion-editor").bounding_box()
                page.mouse.click(top["x"] + 40, top["y"] + 2)
                if page.evaluate("document.activeElement.className") != "notion-doc":
                    failures.append(f"{label}: pressing at the top edge dropped the caret")
                if viewport["width"] > 800:
                    # the gutter still appears on hover and its + button still adds a block
                    page.mouse.move(first["x"] + 30, y)
                    page.wait_for_timeout(300)
                    before = page.locator(".notion-doc > p").count()
                    page.locator('.block-gutter [data-gact="add"]').click()
                    page.wait_for_timeout(200)
                    if page.locator(".notion-doc > p").count() != before + 1:
                        failures.append(f"{label}: gutter + no longer adds a block")
                overflow = page.evaluate("document.documentElement.scrollWidth - innerWidth")
                if overflow > 1:
                    failures.append(f"{label}: page overflows horizontally by {overflow}px")
                # English spell check toggle
                button = page.locator("#spell-toggle")
                language = page.locator("#language-menu summary")
                if not language.is_visible():
                    page.locator("#file-menu > summary").click()
                language.click()
                button.click()
                state = page.evaluate("({doc: document.querySelector('.notion-doc').spellcheck, lang: document.querySelector('.notion-doc').lang, title: document.getElementById('title').spellcheck, stored: localStorage.getItem('memorymap-spell-en')})")
                if state != {"doc": True, "lang": "en", "title": True, "stored": "1"}:
                    failures.append(f"{label}: spell check did not turn on: {state}")
                if button.get_attribute("aria-checked") != "true":
                    failures.append(f"{label}: spell switch state")
                button.click()
                if page.evaluate("document.querySelector('.notion-doc').spellcheck"):
                    failures.append(f"{label}: spell check did not turn off")
                if errors:
                    failures.append(f"{label}: errors {errors}")
                page.close()
            browser.close()
    finally:
        proc.terminate()
    if failures:
        print("FAIL\n" + "\n".join(failures)); sys.exit(1)
    print("PASS line-start press/drag keeps focus and selects, gutter intact, spell check toggle (desktop, phone)")


if __name__ == "__main__":
    main()
