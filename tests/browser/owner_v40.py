"""Browser regression for server-authorized owner statistics with synthetic accounts."""
import os
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
import sys
import tempfile
from threading import Thread

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from playwright.sync_api import expect, sync_playwright
from account_auth import AccountClient
from app import Server
from vault import Vault, VaultError

PASSWORD = "browser-fixture-password-40"
OWNER = "owner-fixture@example.invalid"
REGULAR = "regular-fixture@example.invalid"


def fixture_transport(path, body, token=""):
    if path.startswith("token?grant_type=pkce"):
        email = body["auth_code"]
        return {"user": {"id": email, "email": email, "email_confirmed_at": "2026-01-01", "app_metadata": {"provider": "google"}},
                "access_token": "test-owner-token" if email == OWNER else "test-regular-token",
                "refresh_token": "synthetic", "expires_in": 3600}
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
            providers_transport=lambda: {"external": {"google": True}},
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
                expect(page.locator("#google-gate")).to_be_visible()
                expect(page.locator("#workspace")).to_be_hidden()
                page.context.route("https://fixture.supabase.co/auth/v1/authorize?*", lambda route: route.fulfill(status=200, content_type="text/html", body="<h1>Synthetic Google authorization</h1>"))
                for email in (REGULAR, OWNER):
                    link = page.locator("#gate-google")
                    expect(link).to_have_attribute("aria-disabled", "false")
                    assert page.locator("#gate-google-link").count() == 0
                    url = link.get_attribute("href")
                    with page.expect_popup() as opened:
                        link.click()
                    popup = opened.value
                    popup.wait_for_load_state()
                    assert popup.url == url, popup.url
                    popup.close()
                    callback = parse_qs(urlsplit(url).query)["redirect_to"][0]
                    response = page.request.get(callback + "&code=" + email)
                    assert response.ok, response.text()
                    page.locator("#unlock:not([hidden]) #password:enabled").wait_for()
                    page.fill("#password", PASSWORD)
                    if email == REGULAR:
                        page.fill("#confirmation", PASSWORD)
                    page.click("#unlock-button")
                    page.wait_for_selector("#workspace:not([hidden])")
                    expect(page.locator(".stage-right > :last-child")).to_have_attribute("id", "open-account")
                    expect(page.locator("#account-avatar")).to_have_text("RF" if email == REGULAR else "OF")
                    page.locator("#open-account").click()
                    expect(page.locator("#account-dialog")).to_be_visible()
                    expect(page.locator("#account-status")).to_contain_text(email)
                    if email == REGULAR:
                        expect(page.locator("#account-owner-stats")).to_be_hidden()
                        page.click("#account-signout")
                        expect(page.locator("#google-gate")).to_be_visible()
                        expect(page.locator("#workspace")).to_be_hidden()
                    else:
                        expect(page.locator("#account-owner-stats")).to_be_visible()
                        page.click("#account-owner-stats")
                        expect(page.locator("#owner-stats-content")).to_contain_text("Registered")
                        expect(page.locator("#owner-stats-content")).to_contain_text("12")
                        expect(page.locator("#owner-stats-content")).to_contain_text("Reporting installations")
                        expect(page.locator("#owner-stats-content")).to_contain_text("macos")

                        def usage_unavailable(_token):
                            raise VaultError("Usage service unavailable in this fixture.", 503)

                        server.account.usage_transport = usage_unavailable
                        page.click("#owner-stats-refresh")
                        expect(page.locator("#owner-stats-content")).to_contain_text("12")
                        expect(page.locator("#owner-stats-content")).to_contain_text("Usage service unavailable in this fixture.")
                        page.set_viewport_size({"width": 390, "height": 844})
                        assert page.locator("#account-dialog").evaluate("el => el.scrollWidth <= el.clientWidth + 1")
                        page.locator('[data-settings-tab="data"]').click()
                        expect(page.locator("#backup")).to_be_visible()
                        expect(page.locator("#export")).to_be_visible()
                        expect(page.locator("#export-note-docx")).to_be_disabled()
                        expect(page.locator("#owner-stats-panel")).to_be_hidden()
                        expect(page.locator("#owner-stats-content")).to_be_empty()
                        page.click("#account-close")
                        expect(page.locator("#account-dialog")).to_be_hidden()
                assert not errors, errors
                browser.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
    print("PASS regular user denial, owner-only dashboard, live aggregate rendering, mobile width and dismissal")


if __name__ == "__main__":
    main()
