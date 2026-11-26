"""v28 end-to-end: statistics agreement is required, a ping arrives, feedback reaches the dashboard, opt-out erases everything.

Run: python3 tests/browser/stats_v27.py      (needs Node 22+)
"""
import json, os, subprocess, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(__file__))
import layout_v23  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = layout_v23.ROOT
PORT = 8791
TOKEN = "browser-test-admin-token-1"
PASSWORD = "a-fresh-tester-password-1"


def get(path):
    request = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", headers={"Authorization": "Bearer " + TOKEN})
    return json.load(urllib.request.urlopen(request, timeout=5))


def wait(check, seconds=10):
    end = time.time() + seconds
    while time.time() < end:
        if check():
            return True
        time.sleep(0.25)
    return check()


def main():
    stats = subprocess.Popen(["node", "--no-warnings", os.path.join(ROOT, "stats-worker", "dev-server.mjs"), str(PORT)],
                             env={**os.environ, "ADMIN_TOKEN": TOKEN}, stdout=subprocess.PIPE, text=True)
    stats.stdout.readline()
    os.environ["XOTIRA_STATS_URL"] = f"http://127.0.0.1:{PORT}"
    proc, url = layout_v23.boot(seed=False)
    failures = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(m.text[:160]) if m.type == "error" and "428" not in m.text else None)
            page.goto(url)
            page.locator("#password:enabled").wait_for()
            page.fill("#password", PASSWORD)
            page.fill("#confirmation", PASSWORD)
            page.click("#unlock-button")
            page.locator("#stats-gate[open]").wait_for()
            page.keyboard.press("Escape")
            if not page.locator("#stats-gate").evaluate("d => d.open"):
                failures.append("Escape skipped the statistics agreement")
            if "install_id" not in page.locator("#stats-gate-preview").text_content():
                failures.append("the gate does not show what is sent")
            if get("/admin/stats")["installs"] != 0:
                failures.append("something was sent before the user agreed")
            page.click("#stats-quit")
            page.locator("#password").wait_for(state="visible")
            if page.locator("#workspace").is_visible():
                failures.append("the app stayed open after refusing")
            page.locator("#password:enabled").wait_for()
            page.fill("#password", PASSWORD)
            page.click("#unlock-button")
            page.locator("#stats-gate[open]").wait_for()
            page.click("#stats-agree")
            page.locator("#home-panel .home-page").wait_for()
            page.locator("#nav-map").click()
            if not wait(lambda: get("/admin/stats")["installs"] == 1):
                failures.append("the ping did not arrive after agreeing")
            elif get("/admin/stats")["platforms"][0]["name"] != "linux":
                failures.append("wrong platform")
            # feedback from the graph panel (« button) and from Home
            page.locator("#graph-controls-toggle").click()
            page.locator("#open-feedback").click()
            page.locator("#fb-message").fill("The mind map button is hard to find on my phone")
            page.locator("#fb-contact").fill("@tester")
            page.locator("#fb-kind").select_option("idea")
            page.locator("#feedback-form button[type=submit]").click()
            page.locator("#feedback-dialog").wait_for(state="hidden")
            items = get("/admin/feedback")["items"]
            if len(items) != 1 or items[0]["kind"] != "idea" or items[0]["contact"] != "@tester":
                failures.append(f"feedback not stored as typed: {items}")
            page.locator("#nav-home").click()
            page.get_by_role("button", name="Send feedback").click()
            page.locator("#feedback-dialog[open]").wait_for()
            page.locator("#fb-cancel").click()
            # switching statistics off brings the gate back; leaving erases the server-side data
            page.get_by_role("button", name="Usage statistics: on (turn off)").click()
            page.locator("#stats-gate[open]").wait_for()
            page.click("#stats-quit")
            if not wait(lambda: get("/admin/stats")["installs"] == 0 and not get("/admin/feedback")["items"]):
                failures.append("withdrawing did not erase installs and feedback")
            if errors:
                failures.append(f"errors {errors}")
            browser.close()
    finally:
        proc.terminate()
        stats.terminate()
    if failures:
        print("FAIL\n" + "\n".join(failures))
        sys.exit(1)
    print("PASS statistics gate, ping, feedback, withdrawal (end to end)")


if __name__ == "__main__":
    main()
