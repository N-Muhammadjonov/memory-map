"""Synthetic identity for isolated test vaults; never packaged with the application."""
from __future__ import annotations
import time
from account_auth import AccountClient


def fixture_account(email: str = "fixture@example.invalid", *, owner: bool = False) -> AccountClient:
    account = AccountClient("https://fixture.supabase.co", "sb_publishable_fixture", "https://fixture.invalid",
                            transport=lambda *_: {}, owner_transport=lambda _: {"owner": owner},
                            providers_transport=lambda: {"external": {"google": True}})
    account.user = {"id": email, "email": email}
    account.access_token = "synthetic-test-token"
    account.google_session = True
    account.expires_at = time.monotonic() + 3600
    return account
