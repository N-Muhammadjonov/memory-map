"""Browser regression for server-authorized owner statistics with synthetic accounts."""
import os
from pathlib import Path
import sys
import tempfile
from threading import Thread

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from playwright.sync_api import expect, sync_playwright
from account_auth import AccountClient
from app import Server
from vault import Vault

PASSWORD = "browser-fixture-password-40"
OWNER = "owner-fixture@example.invalid"
REGULAR = "regular-fixture@example.invalid"


def fixture_transport(path, body, token=""):
    if path.startswith("token?"):
        email = body["email"]
        return {"user": {"id": email, "email": email, "email_confirmed_at": "2026-01-01"},
                "access_token": "test-owner-token" if email == OWNER else "test-regular-token"}
    return {}


def main():
    with tempfile.TemporaryDirectory() as directory:
        vault = Vault(Path(directory) / "synthetic.xotira")
        server = Server(vault, None)
        server.telemetry.endpoint = ""
        server.account = AccountClient(
            "https://fixture.supabase.co", "sb_publishable_fixture", "https://fixture.invalid",
            transport=fixture_transport,
            owner_transport=lambda token: {"owner": token == "test-owner-token", "registered": 12,
                                           "confirmed": 11, "newLast7": 2, "signedInLast30": 7},
            usage_transport=lambda token: {"installs": 5, "active": {"today": 3, "last7": 4, "last30": 5},
                                           "platforms": [{"name": "macos", "installs": 3}],
                                           "feedbackCount": 0, "features": [{"name": "graph", "installs": 3}]},
            providers_transport=lambda: {"external": {"google": False}},
        )
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(**({"executable_path": os.environ["QA_BROWSER"]} if os.environ.get("QA_BROWSER") else {}))
                page = browser.new_page(viewport={"width": 1280, "height": 800})
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(server.origin + "/#" + server.token)
                page.locator("#password:enabled").wait_for()
                page.fill("#password", PASSWORD)
                page.fill("#confirmation", PASSWORD)
                page.click("#unlock-button")
                page.wait_for_selector("#workspace:not([hidden])")
                page.locator("#file-menu summary").click()
                page.locator("#open-account").click()
                expect(page.locator("#account-dialog")).to_be_visible()
                expect(page.locator("#account-google")).to_be_disabled()
                expect(page.locator("#account-owner-stats")).to_be_hidden()
                for email in (REGULAR, OWNER):
                    page.fill("#account-email", email)
                    page.fill("#account-password", PASSWORD)
                    page.locator("#account-form button[value=sign-in]").click()
                    expect(page.locator("#account-status")).to_contain_text(email)
                    if email == REGULAR:
                        expect(page.locator("#account-owner-stats")).to_be_hidden()
                        page.click("#account-signout")
                    else:
                        expect(page.locator("#account-owner-stats")).to_be_visible()
                        page.click("#account-owner-stats")
                        expect(page.locator("#owner-stats-content")).to_contain_text("Registered")
                        expect(page.locator("#owner-stats-content")).to_contain_text("12")
                        expect(page.locator("#owner-stats-content")).to_contain_text("Reporting installations")
                        expect(page.locator("#owner-stats-content")).to_contain_text("macos")
                        page.set_viewport_size({"width": 390, "height": 844})
                        assert page.locator("#owner-stats-dialog").evaluate("el => el.scrollWidth <= el.clientWidth + 1")
                        page.click("#owner-stats-close")
                        expect(page.locator("#owner-stats-content")).to_be_empty()
                assert not errors, errors
                browser.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
    print("PASS regular user denial, owner-only dashboard, live aggregate rendering, mobile width and dismissal")


if __name__ == "__main__":
    main()
