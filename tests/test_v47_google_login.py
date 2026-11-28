"""Regression coverage for portable TLS, single-click OAuth and safe retry."""
from __future__ import annotations

import io
import json
import os
import ssl
import tempfile
import time
import unittest
from pathlib import Path
from threading import Thread
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

from account_auth import AccountClient
from app import Server
from secure_transport import verified_context
from vault import Vault, VaultError


ORIGIN = "http://127.0.0.1:48199"


def nonce_for(url: str) -> str:
    redirect = parse_qs(urlsplit(url).query)["redirect_to"][0]
    return parse_qs(urlsplit(redirect).query)["nonce"][0]


class GoogleSignInTests(unittest.TestCase):
    def setUp(self) -> None:
        self.calls = []
        self.payload = {
            "user": {"id": "fixture", "email": "fixture@example.invalid",
                     "email_confirmed_at": "2026-01-01", "app_metadata": {"provider": "google"}},
            "access_token": "synthetic-token", "refresh_token": "synthetic-refresh", "expires_in": 3600,
        }

        def transport(path, body, token=""):
            self.calls.append((path, body))
            if body.get("auth_code") == "network-error":
                raise VaultError("Could not connect to the account service securely. Try again.", 503)
            return self.payload

        self.account = AccountClient(
            "https://fixture.supabase.co", "sb_publishable_fixture", "https://fixture.invalid",
            transport=transport, providers_transport=lambda: {"external": {"google": True}},
            owner_transport=lambda _: {"owner": False})

    def test_portable_trust_store_does_not_disable_verification(self) -> None:
        verified_context.cache_clear()
        try:
            with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {
                "SSL_CERT_FILE": str(Path(folder)/"missing-ca"),
                "SSL_CERT_DIR": str(Path(folder)/"missing-dir"),
            }):
                context = verified_context()
                self.assertGreater(context.cert_store_stats()["x509_ca"], 0)
                self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
                self.assertTrue(context.check_hostname)
        finally:
            verified_context.cache_clear()

    def test_ready_link_is_local_preparation_and_stable(self) -> None:
        first = self.account.google_login(ORIGIN)
        second = self.account.google_login(ORIGIN)
        self.assertEqual(first, second)
        params = parse_qs(urlsplit(first["url"]).query)
        self.assertEqual(params["provider"], ["google"])
        self.assertEqual(params["code_challenge_method"], ["s256"])
        self.assertEqual(self.calls, [])
        self.assertNotIn(self.account.oauth[1], first["url"])

    def test_network_failure_prepares_fresh_link_and_stale_code_cannot_cancel(self) -> None:
        first = self.account.google_login(ORIGIN)["url"]
        with self.assertRaisesRegex(VaultError, "connect"):
            self.account.finish_google(nonce_for(first), "network-error")
        retry = self.account.google_login(ORIGIN)
        self.assertIn("connect", retry["message"])
        self.assertNotEqual(first, retry["url"])
        with self.assertRaises(VaultError):
            self.account.finish_google(nonce_for(first), "stale")
        self.assertEqual(self.account.google_login(ORIGIN)["url"], retry["url"])
        self.assertTrue(self.account.finish_google(nonce_for(retry["url"]), "valid-fixture"))
        self.assertTrue(self.account.authorized())
        self.assertEqual(self.account.google_login(ORIGIN)["url"], "")

    def test_cancelled_and_expired_attempts_can_retry(self) -> None:
        first = self.account.google_login(ORIGIN)["url"]
        with self.assertRaisesRegex(VaultError, "cancelled"):
            self.account.finish_google(nonce_for(first), "", provider_error="access_denied")
        retry = self.account.google_login(ORIGIN)
        self.assertIn("cancelled", retry["message"])
        self.assertNotEqual(first, retry["url"])
        nonce, verifier, _ = self.account.oauth
        self.account.oauth = (nonce, verifier, time.monotonic()-1)
        self.assertIn("expired", self.account.google_login(ORIGIN)["message"])
        self.assertFalse(self.account.authorized())

    def test_callback_removes_code_from_address_and_reports_error_in_app(self) -> None:
        with tempfile.TemporaryDirectory() as folder, Server(Vault(Path(folder)/"test.xotira"), None, account=self.account) as server:
            server.telemetry.endpoint = ""
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            def status() -> dict:
                with urlopen(Request(server.origin+"/api/status", headers={"Authorization":"Bearer "+server.token}), timeout=5) as res:
                    return json.load(res)
            try:
                login = status()["googleLogin"]
                callback = parse_qs(urlsplit(login["url"]).query)["redirect_to"][0]
                with urlopen(callback+"&code=network-error", timeout=5) as response:
                    self.assertTrue(response.url.endswith("/account/result/error"))
                    self.assertIn(b"Sign-in could not finish", response.read())
                retry = status()
                self.assertFalse(retry["authenticated"])
                self.assertIn("connect", retry["googleLogin"]["message"])
                self.assertNotEqual(login["url"], retry["googleLogin"]["url"])
                callback = parse_qs(urlsplit(retry["googleLogin"]["url"]).query)["redirect_to"][0]
                with urlopen(callback+"&code=valid-fixture", timeout=5) as response:
                    self.assertTrue(response.url.endswith("/account/result/success"))
                    self.assertIn(b"Account connected", response.read())
                self.assertTrue(status()["authenticated"])
                self.assertFalse(status()["unlocked"])
            finally:
                server.shutdown()
                thread.join(timeout=5)

    def test_transient_refresh_failure_never_authorizes_an_expired_token(self) -> None:
        link = self.account.google_login(ORIGIN)["url"]
        self.assertTrue(self.account.finish_google(nonce_for(link), "valid-fixture"))
        self.account.expires_at = time.monotonic()+20
        def unavailable(*_args):
            raise VaultError("Temporary network error", 503)
        self.account.transport = unavailable
        self.assertTrue(self.account.authorized())  # previous verified session is still valid
        self.assertGreater(self.account.refresh_retry_at, time.monotonic())
        self.account.expires_at = time.monotonic()-1
        self.assertFalse(self.account.authorized())
        self.assertFalse(self.account.google_session)

    def test_transport_reports_tls_and_provider_code_without_secret_payload(self) -> None:
        with patch("account_auth.verified_opener") as opener:
            opener.return_value.open.side_effect = URLError(ssl.SSLCertVerificationError("sensitive diagnostic"))
            with self.assertRaisesRegex(VaultError, "HTTPS certificate") as error:
                self.account._request("token?grant_type=pkce", {})
            self.assertNotIn("sensitive diagnostic", str(error.exception))
            opener.return_value.open.side_effect = HTTPError("https://fixture.supabase.co/auth/v1/token", 400,
                "bad request", {}, io.BytesIO(b'{"error_code":"flow_state_not_found","message":"sensitive token"}'))
            with self.assertRaisesRegex(VaultError, "sign-in code"):
                self.account._request("token?grant_type=pkce", {})
