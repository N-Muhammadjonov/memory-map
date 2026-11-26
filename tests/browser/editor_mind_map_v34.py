"""Regression test for the note caret, inline mind maps and text after blocks."""

import os

from playwright.sync_api import expect, sync_playwright

from layout_v23 import boot

PASSWORD = "disposable-browser-test-password"


def check_editor(page, url):
    page.goto(url)
    page.locator("#password:enabled").wait_for()
    page.fill("#password", PASSWORD)
    page.fill("#confirmation", PASSWORD)
    page.click("#unlock-button")
    page.locator(".home-actions .primary").click()
    page.fill("#new-title", "Writing after blocks")
    page.locator("#create-form button[type=submit]").click()

    doc = page.locator(".notion-doc")
    expect(doc).to_be_focused()
    assert doc.evaluate("""doc => {
      const selection = getSelection();
      return selection.isCollapsed && selection.anchorOffset === 0 &&
        doc.firstElementChild.contains(selection.anchorNode);
    }""")

    page.keyboard.type("/code")
    page.keyboard.press("Enter")
    code = doc.locator(".n-code code")
    expect(doc.locator(".n-code-box")).to_be_visible()
    page.keyboard.type("example")
    page.keyboard.press("Shift+Enter")
    page.keyboard.type("Text after code")
    expect(doc.locator(".n-code-box + p")).to_have_text("Text after code")
    expect(code).to_have_text("example")

    page.click("#note-mind-new")
    page.fill("#mind-title", "Map for the note")
    page.click("#mind-create-submit")
    board = doc.locator(".inline-mind-card")
    root = board.locator(".mind-topic[data-root] > button")
    expect(root).to_have_text("Map for the note")
    root.dblclick()
    rename = board.locator(".mind-rename")
    expect(rename).to_be_focused()
    rename.fill("New map title")
    rename.press("Enter")
    expect(root).to_have_text("New map title")
    expect(page.locator("#title")).to_have_value("Writing after blocks")
    board.get_by_label("Topic color").select_option("teal")

    board.get_by_role("button", name="+ Branch", exact=True).click()
    branch = board.get_by_role("button", name="New topic", exact=True)
    branch.dblclick()
    rename.fill("A bigger rectangle with a line of text")
    rename.press("Enter")
    branch = board.get_by_role("button", name="A bigger rectangle with a line of text", exact=True)
    width, height = branch.evaluate("card => [card.offsetWidth, card.offsetHeight]")
    assert 172 < width <= 344 and 52 <= height <= 104, (width, height)
    board.get_by_label("Topic color").select_option("orange")
    board.get_by_role("button", name="+ Sibling", exact=True).click()
    sibling = board.get_by_role("button", name="New topic", exact=True)
    sibling.dblclick()
    long_title = ("Batafsil va to‘liq ko‘rinadigan matn " * 13).strip()
    rename.fill(long_title)
    rename.press("Enter")
    long_card = board.get_by_role("button", name=long_title, exact=True)
    expect(long_card.locator("..")).to_have_attribute("data-clipped", "true")
    assert long_card.evaluate("card => card.offsetHeight") == 104
    long_card.click()
    expect(long_card.locator("..")).to_have_attribute("data-clipped", "false")
    assert long_card.evaluate("card => card.offsetHeight > 104 && card.firstElementChild.offsetHeight < card.offsetHeight")
    long_card.dblclick()
    rename.fill("Discard this")
    rename.press("Escape")
    expect(long_card).to_have_text(long_title)

    line = doc.locator(".n-mind-slot + p")
    line.click(position={"x": 8, "y": 8})
    page.keyboard.type("Text after mind map")
    expect(line).to_have_text("Text after mind map")
    page.keyboard.press("End")
    page.keyboard.press("Enter")
    page.keyboard.type("/table")
    page.keyboard.press("Enter")
    table_line = doc.locator(".n-table-wrap + p")
    table_line.click(position={"x": 8, "y": 8})
    page.keyboard.type("Text after table")
    expect(table_line).to_have_text("Text after table")

    expect(page.locator("#saved")).to_have_text("Saved")
    page.reload()
    page.locator("#home-panel").get_by_role("button", name="Writing after blocks", exact=True).click()
    expect(doc.locator(".n-code-box + p")).to_have_text("Text after code")
    expect(doc.locator(".n-mind-slot + p")).to_have_text("Text after mind map")
    expect(doc.locator(".n-table-wrap + p")).to_have_text("Text after table")
    expect(board.locator(".mind-topic[data-root]")).to_have_class("mind-topic mind-tone-teal")
    expect(branch.locator("..")).to_have_class("mind-topic mind-tone-orange")
    expect(long_card).to_have_text(long_title)
    board.get_by_role("button", name="Expand mind map").click()
    viewer = page.locator("#viewer-panel")
    expect(viewer.get_by_role("button", name=long_title, exact=True)).to_be_visible()
    viewer.get_by_role("button", name="New map title", exact=True).dblclick()
    viewer.locator(".mind-rename").fill("Edited in the full map")
    viewer.locator(".mind-rename").press("Enter")
    page.get_by_role("button", name="Back to note").click()
    expect(root).to_have_text("Edited in the full map")

    # Maps created before v34 have an attachment but no placement link in the note.
    page.click("#toggle-source")
    page.fill("#body", "Legacy text before map")
    expect(page.locator("#saved")).to_have_text("Saved")
    page.reload()
    page.locator("#home-panel").get_by_role("button", name="Writing after blocks", exact=True).click()
    expect(root).to_have_text("Edited in the full map")
    expect(doc.locator(".n-mind-slot")).to_have_count(1)
    legacy_line = doc.locator(".n-mind-slot + p")
    legacy_line.click(position={"x": 8, "y": 8})
    page.keyboard.type("Legacy text after map")
    expect(legacy_line).to_have_text("Legacy text after map")


def main():
    server, url = boot(seed=False)
    try:
        with sync_playwright() as playwright:
            browser_path = os.getenv("QA_BROWSER")
            browser = playwright.chromium.launch(**({"executable_path": browser_path} if browser_path else {}))
            page = browser.new_page(viewport={"width": 1440, "height": 990})
            page.set_default_timeout(7000)
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            check_editor(page, url)
            assert not errors, errors
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=5)
    print("PASS note caret, inline map editing, colors, resizing and text continuation")


if __name__ == "__main__":
    main()
