"""Mandatory Google identity, session expiry, contact-free feedback and voice state."""
from __future__ import annotations
import json
import tempfile
import time
import unittest
from pathlib import Path
from threading import Thread
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen
from unittest.mock import patch

from account_auth import AccountClient
from app import Server
from vault import Vault
from voice_service import VoiceService


class V46AccessTests(unittest.TestCase):
    def test_google_required_before_any_private_api(self):
        payload = {"user": {"id": "fixture", "email": "fixture@example.invalid",
                             "email_confirmed_at": "2026-01-01", "app_metadata": {"provider": "google"}},
                   "access_token": "mock", "refresh_token": "mock-refresh", "expires_in": 3600}
        def transport(path, body, token=""):
            return payload if path == "token?grant_type=pkce" else {}
        account = AccountClient("https://fixture.supabase.co", "sb_publishable_fixture", "https://fixture.invalid",
                                transport=transport, owner_transport=lambda _: {"owner": False},
                                providers_transport=lambda: {"external": {"google": True}})
        with tempfile.TemporaryDirectory() as folder, Server(Vault(Path(folder)/"test.xotira"), None, account=account) as server:
            server.telemetry.endpoint = ""
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            def call(route, body=None):
                headers = {"Authorization": "Bearer "+server.token}
                if body is not None:
                    headers.update({"Origin":server.origin, "Content-Type":"application/json"})
                with urlopen(Request(server.origin+route, json.dumps(body).encode() if body is not None else None, headers), timeout=8) as response:
                    return response.read()
            try:
                self.assertFalse(json.loads(call("/api/status"))["authenticated"])
                for route, body in [("/api/create", {"password":"fixture-password"}), ("/api/unlock", {"password":"fixture-password"}),
                                    ("/api/notes", None), ("/api/graph", None), ("/api/feedback", {"kind":"bug"}), ("/api/account", {"action":"sign-in"})]:
                    with self.assertRaises(HTTPError) as error:
                        call(route, body)
                    self.assertEqual(error.exception.code, 401)
                self.assertFalse(server.vault.exists)
                url = json.loads(call("/api/account", {"action":"google"}))["url"]
                callback = parse_qs(urlsplit(url).query)["redirect_to"][0]
                local_callback = callback.removeprefix(server.origin)
                call(local_callback + "&code=fixture")
                self.assertTrue(json.loads(call("/api/status"))["authenticated"])
                call("/api/create", {"password":"fixture-password"})
                self.assertTrue(json.loads(call("/api/status"))["unlocked"])
                with patch.object(server.telemetry, "send_feedback") as send:
                    call("/api/feedback", {"kind":"bug", "message":"fixture message", "contact":"must not send"})
                    send.assert_called_once_with("bug", "fixture message", "", "")
                call("/api/lock", {})
                self.assertTrue(json.loads(call("/api/status"))["authenticated"])
                call("/api/unlock", {"password":"fixture-password"})
                account.expires_at = time.monotonic()-1
                self.assertFalse(json.loads(call("/api/status"))["authenticated"])
                self.assertIsNone(server.vault.cipher)
            finally:
                server.shutdown()
                thread.join(timeout=5)

    def test_voice_lifecycle_and_stale_callback(self):
        service = VoiceService()
        identifier = "1"*36
        service.id = identifier
        service.phase = "starting"
        service.started = time.monotonic()
        self.assertEqual(service.status(identifier)["phase"], "starting")
        service.update(identifier, partial="hello", listening=True)
        self.assertEqual(service.status(identifier)["partial"], "hello")
        service.finish(identifier)
        self.assertEqual(service.status(identifier)["text"], "hello")
        service.cancel()
        service.update(identifier, final="stale", listening=True)
        self.assertEqual(service.status(identifier)["phase"], "idle")
