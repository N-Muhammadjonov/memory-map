"""v28: the </> button in the selection bar makes a real code block (not an inline chip) and keeps the surrounding text.

Run: python3 tests/browser/code_block_v28.py
"""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from layout_v23 import boot  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

PASSWORD = "a-fresh-tester-password-1"


def select_text(page, needle):
    """Select `needle` inside the editor with a real DOM range, then fire the events the app listens for."""
    page.evaluate("""needle => {
      const doc = document.querySelector('.notion-doc');
      const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const at = node.textContent.indexOf(needle);
        if (at >= 0) {
          const range = document.createRange();
          range.setStart(node, at); range.setEnd(node, at + needle.length);
          const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
          document.dispatchEvent(new Event('selectionchange'));
          return;
        }
      }
      throw new Error('text not found');
    }""", needle)
    page.wait_for_timeout(250)


def main():
    proc, url = boot(seed=False)
    failures = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(url)
            page.locator("#password:enabled").wait_for()
            page.fill("#password", PASSWORD); page.fill("#confirmation", PASSWORD); page.click("#unlock-button")
            page.locator("#home-panel .home-page").wait_for()
            page.locator(".home-actions .primary").click()
            page.locator("#create-dialog[open] #new-title").fill("Code test")
            page.locator("#create-form button[type=submit]").click()
            page.locator(".notion-doc").wait_for()
            page.locator(".notion-doc p, .notion-doc").first.click()
            page.keyboard.type('before print("Salom") after')
            # 1) a selection in the middle of a paragraph becomes a block; the rest stays as paragraphs
            select_text(page, 'print("Salom")')
            page.locator('#bubble-bar [data-cmd="code"]').click()
            page.wait_for_timeout(300)
            boxes = page.locator(".notion-doc .n-code-box")
            if boxes.count() != 1:
                failures.append(f"expected one code block, found {boxes.count()}")
            elif 'print("Salom")' not in boxes.first.locator("pre.n-code code").inner_text():
                failures.append("the code block does not hold the selected text")
            if page.locator(".notion-doc code:not(.n-code code)").filter(has_text="Salom").count():
                failures.append("the selection became an inline chip instead of a block")
            paragraphs = page.locator(".notion-doc > p").all_inner_texts()
            if [t.strip() for t in paragraphs if t.strip()] != ["before", "after"]:
                failures.append(f"surrounding text was not kept: {paragraphs}")
            # 2) the dedicated inline button still makes an inline code span
            page.locator(".notion-doc > p", has_text="after").click()
            select_text(page, "after")
            page.locator('#bubble-bar [data-cmd="inline-code"]').click()
            if page.locator(".notion-doc > p code").count() != 1:
                failures.append("the inline code button no longer produces inline code")
            # 3) it is saved as a fenced block and survives reopening
            page.wait_for_timeout(1500)
            page.locator("#nav-home").click()
            page.locator("#home-panel .home-note-row", has_text="Code test").click()
            page.locator(".notion-doc .n-code-box").wait_for()
            if errors:
                failures.append(f"errors {errors}")
            browser.close()
    finally:
        proc.terminate()
    if failures:
        print("FAIL\n" + "\n".join(failures)); sys.exit(1)
    print("PASS </> makes a code block, keeps surrounding text, inline button intact, survives reopening")


if __name__ == "__main__":
    main()
