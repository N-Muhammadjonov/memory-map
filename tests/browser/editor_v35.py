"""Verify v35 cursor animation, symbol conversions, word reuse and inline branches."""

import os

from playwright.sync_api import expect, sync_playwright

from layout_v23 import boot

PASSWORD = "disposable-v35-browser-password"


def create_note(page, title):
    page.locator(".home-actions .primary").click()
    page.fill("#new-title", title)
    page.locator("#create-form button[type=submit]").click()
    expect(page.locator("#title")).to_have_value(title)
    expect(page.locator(".notion-doc")).to_be_focused()


def open_note(page, title):
    page.click("#nav-home")
    page.locator("#home-panel").get_by_role("button", name=title, exact=True).click()
    expect(page.locator("#title")).to_have_value(title)


def trash_note(page):
    if not page.locator("#remove").is_visible():
        page.click("#note-attachments")
    page.click("#remove")
    expect(page.locator("#home-panel")).to_be_visible()


def check_editor(page):
    create_note(page, "Ha")
    doc = page.locator(".notion-doc")
    caret = doc.locator("p[data-empty-caret]")
    expect(caret).to_be_visible()
    for opacity in ("1", "0", "1"):
        page.wait_for_function(
            """opacity => {
                const paragraph = document.querySelector(".notion-doc p[data-empty-caret]");
                return paragraph && getComputedStyle(paragraph, "::after").opacity === opacity;
            }""",
            arg=opacity, timeout=2500,
        )
    page.keyboard.type("=>")
    expect(caret).to_have_count(0)
    page.keyboard.press("Enter")
    expect(doc.locator("p").first).to_have_text("⇒")
    expect(caret).to_be_visible()
    page.keyboard.type("-> <- <-> <=> <= >= != +/- (c) (TM) 1/2 11/2 ... rest---")
    page.keyboard.press("Enter")
    expect(doc.locator("p").nth(1)).to_have_text("→ ← ↔ ⇔ ≤ ≥ ≠ ± © ™ ½ 11/2 … rest—")
    page.keyboard.type("/code")
    page.keyboard.press("Enter")
    page.keyboard.type("x => y")
    page.keyboard.press("Enter")
    expect(doc.locator(".n-code code")).to_contain_text("x => y")
    page.click("#title")
    expect(caret).to_have_count(0)

    trash_note(page)
    create_note(page, "Ha")
    expect(page.locator("#notes").get_by_role("button", name="Ha", exact=True)).to_have_count(1)
    expect(doc.locator("p").first).to_have_text("")


def check_map(page):
    page.click("#nav-home")
    create_note(page, "Legacy topic")
    page.keyboard.type("Text saved in an older branch note.")
    open_note(page, "Ha")
    page.click("#note-mind-new")
    page.fill("#mind-title", "Study map")
    page.click("#mind-create-submit")
    board = page.locator(".inline-mind-card")
    expect(board.get_by_role("button", name="Open branch", exact=True)).to_have_count(0)
    board.get_by_role("button", name="+ Branch", exact=True).click()
    board.get_by_role("button", name="New topic", exact=True).dblclick()
    rename = board.locator(".mind-rename")
    expect(rename).to_be_focused()
    rename.fill("HA")
    rename.press("Enter")
    branch = board.get_by_role("button", name="HA", exact=True)
    board.locator("summary", has_text="Topic details").click()
    description = "First line of this branch.\n" + "More details from the branch. " * 15 + "\nLast line."
    details = board.get_by_label("Description", exact=True)
    details.fill(description)
    details.press("Tab")
    board.locator("label", has_text="Link a note").locator("select").select_option(label="Legacy topic")
    board.locator("summary", has_text="Topic details").click()

    text = branch.locator(".mind-description")
    expect(text).to_be_hidden()
    branch.click()
    expect(branch).to_have_attribute("aria-expanded", "true")
    expect(text).to_contain_text("Last line.")
    expect(text).to_contain_text("Text saved in an older branch note.")
    assert branch.evaluate("(card) => card.scrollHeight - card.clientHeight < 2")
    expect(page.locator("#title")).to_have_value("Ha")
    branch.press("Space")
    expect(text).to_be_hidden()
    expect(branch).to_have_attribute("aria-expanded", "false")

    open_note(page, "Legacy topic")
    trash_note(page)
    open_note(page, "Ha")
    branch.click()
    expect(text).to_contain_text("Last line.")
    expect(text).not_to_contain_text("Text saved in an older branch note.")
    expect(page.locator("#notes").get_by_role("button", name="Legacy topic", exact=True)).to_have_count(0)


def main():
    server, url = boot(seed=False)
    try:
        with sync_playwright() as playwright:
            engine = getattr(playwright, os.getenv("QA_ENGINE", "chromium"))
            browser_path = os.getenv("QA_BROWSER")
            browser = engine.launch(**({"executable_path": browser_path} if browser_path else {}))
            page = browser.new_page(viewport={"width": 1440, "height": 1000})
            page.set_default_timeout(8000)
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(url)
            page.locator("#password:enabled").wait_for()
            page.fill("#password", PASSWORD)
            page.fill("#confirmation", PASSWORD)
            page.click("#unlock-button")
            check_editor(page)
            check_map(page)
            assert not errors, errors
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=5)
    print("PASS blinking caret, symbol shortcuts, Trash title reuse and inline branch text")


if __name__ == "__main__":
    main()
