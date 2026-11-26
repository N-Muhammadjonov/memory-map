"""v23 real-browser layout regression checks (Playwright for Python + Chromium).

Run:  python3 tests/browser/layout_v23.py
Covers: viewer image fits the pane, landscape sidebar keeps the notes list reachable,
drawing dialog Save/Cancel stay on screen, property row stays on one line, no CSP errors.
"""
import os, re, subprocess, sys, tempfile
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PASSWORD = "xotira-disposable-browser-fixture"


def boot(seed=True):
    vault = os.path.join(tempfile.mkdtemp(prefix="xotira-v23-"), "a.xotira")
    if seed:
        result = subprocess.run([sys.executable, os.path.join(ROOT, "tests", "batch1_fixtures.py"), vault], cwd=ROOT,
                                env={**os.environ, "PYTHONPATH": ROOT}, capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
    proc = subprocess.Popen([sys.executable, "app.py", "--vault", vault, "--no-browser"], cwd=ROOT,
                            stdout=subprocess.PIPE, text=True)
    url = re.search(r"http://127\.0\.0\.1:\d+/#\S+", proc.stdout.readline()).group(0)
    return proc, url


def open_workspace(browser, url, viewport):
    page = browser.new_page(viewport=viewport, has_touch=viewport["width"] < 900)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text[:160]) if m.type == "error" else None)
    page.goto(url)
    page.wait_for_timeout(700)
    if page.locator("#password").is_visible():
        page.locator("#password").wait_for(state="visible")
        page.wait_for_function("!document.querySelector('#password').disabled")
        page.fill("#password", PASSWORD)
        page.click("#unlock-button")
    page.wait_for_selector("#workspace:not([hidden])")
    page.wait_for_timeout(500)
    if not page.locator("#notes").is_visible():
        page.locator("#toggle-sidebar").click()
        page.wait_for_timeout(250)
    return page, errors


def main():
    proc, url = boot()
    failures = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            for label, viewport in [("desktop", {"width": 1280, "height": 800}),
                                    ("phone", {"width": 390, "height": 844}),
                                    ("phone-landscape", {"width": 844, "height": 390})]:
                page, errors = open_workspace(browser, url, viewport)
                page.locator("#notes").get_by_role("button", name="Mixed image note", exact=True).click()
                page.wait_for_selector(".n-img-slot img")
                row = page.evaluate("""()=>{const a=document.querySelector('#prop-status').getBoundingClientRect(),
                  b=document.querySelector('#prop-due').getBoundingClientRect();return Math.abs(a.top-b.top)<14}""")
                if not row and viewport["width"] >= 700: failures.append(f"{label}: status and due date are not on one row")
                page.locator(".n-img-slot img").first.click()
                page.wait_for_selector("#viewer-panel img")
                img = page.evaluate("""()=>{const r=document.querySelector('#viewer-panel img').getBoundingClientRect();
                  return {l:r.left,r:r.right,vw:innerWidth,doc:document.documentElement.scrollWidth}}""")
                if img["l"] < -1 or img["r"] > img["vw"] + 1 or img["doc"] > img["vw"] + 1:
                    failures.append(f"{label}: viewer image overflows {img}")
                if errors: failures.append(f"{label}: console/page errors {errors}")
                page.close()
                if label == "desktop":
                    continue
                page, _ = open_workspace(browser, url, viewport)
                page.locator("#notes").get_by_role("button", name="Drawing fixtures", exact=True).click()
                page.wait_for_selector(".n-img-slot button")
                page.locator(".n-img-slot button").last.click()
                page.locator("#viewer-draw-edit").click()
                page.locator("#draw-surface").wait_for()
                page.wait_for_timeout(300)
                bounds = page.evaluate("""()=>{const s=document.querySelector('#draw-save').getBoundingClientRect(),
                  c=document.querySelector('#draw-cancel').getBoundingClientRect();
                  return {sb:s.bottom,cb:c.bottom,vh:innerHeight}}""")
                if bounds["sb"] > bounds["vh"] or bounds["cb"] > bounds["vh"]:
                    failures.append(f"{label}: draw Save/Cancel are off screen {bounds}")
                page.close()
            browser.close()
    finally:
        proc.terminate()
    if failures:
        print("FAIL\n" + "\n".join(failures))
        sys.exit(1)
    print("PASS v23 layout checks (desktop, phone, phone-landscape)")


if __name__ == "__main__":
    main()
