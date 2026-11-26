"""Optional cloud identity, independent of local encrypted notes."""
from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
import time
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from vault import VaultError
from telemetry import VERSION


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class AccountClient:
    def __init__(self, url: str, key: str, site_url: str, *, transport: Callable | None = None,
                 owner_transport: Callable | None = None, usage_transport: Callable | None = None,
                 providers_transport: Callable | None = None):
        self.url = url.rstrip("/")
        self.key = key
        parts = urlsplit(self.url)
        self.configured = bool(parts.scheme == "https" and parts.hostname
                               and parts.hostname.endswith(".supabase.co")
                               and not parts.username and not parts.password and not parts.path
                               and not parts.query and not parts.fragment and key.startswith("sb_publishable_"))
        self.site_url = site_url
        self.transport = transport or self._request
        self.owner_transport = owner_transport or self._request_owner
        self.usage_transport = usage_transport or self._request_usage
        self.providers_transport = providers_transport or self._request_providers
        self._provider_cache: tuple[float, bool] | None = None
        self.reset()

    def reset(self) -> None:
        self.user: dict[str, str] = {}
        self.access_token = ""
        self.oauth: tuple[str, str, float] | None = None
        self.message = ""
        self.is_owner = False

    def status(self) -> dict[str, Any]:
        self.is_owner = False
        if self.access_token:
            try:
                self.is_owner = self._owner_summary().get("owner") is True
            except VaultError:
                # Owner access is never inferred from a local email or cached after a failed check.
                self.is_owner = False
        return {"configured": self.configured, "user": self.user.copy(),
                "message": self.message, "owner": self.is_owner,
                "googleAvailable": self.google_available()}

    def _require(self) -> None:
        if not self.configured:
            raise VaultError("Online account service is not configured.", 503)

    def _request(self, path: str, body: dict[str, Any], token: str = "") -> dict[str, Any]:
        return self._post_json(self.url + "/auth/v1/" + path, body, token)

    def _post_json(self, url: str, body: dict[str, Any], token: str = "") -> dict[str, Any]:
        self._require()
        headers = {"apikey": self.key, "Content-Type": "application/json", "Accept": "application/json",
                   "User-Agent": f"MemoryMap/{VERSION}"}
        if token:
            headers["Authorization"] = "Bearer " + token
        request = Request(url, method="POST", headers=headers,
                          data=json.dumps(body).encode("utf-8"))
        try:
            with build_opener(NoRedirect).open(request, timeout=12) as response:
                raw = response.read(256 * 1024)
            result = json.loads(raw) if raw else {}
        except HTTPError as error:
            if error.code == 429:
                raise VaultError("Too many requests. Try again later.", 429) from None
            if error.code == 400 or error.code == 401 or error.code == 422:
                raise VaultError("Account request failed. Check your credentials or confirmation email.", 400) from None
            raise VaultError("Account service is temporarily unavailable.", 503) from None
        except (URLError, OSError, ValueError):
            raise VaultError("Account service is temporarily unavailable.", 503) from None
        return result if isinstance(result, dict) else {}

    def _request_providers(self) -> dict[str, Any]:
        self._require()
        request = Request(self.url + "/auth/v1/settings",
                          headers={"apikey": self.key, "Accept": "application/json",
                                   "User-Agent": f"MemoryMap/{VERSION}"})
        try:
            with build_opener(NoRedirect).open(request, timeout=5) as response:
                result = json.loads(response.read(128 * 1024))
        except (HTTPError, URLError, OSError, ValueError):
            return {}
        return result if isinstance(result, dict) else {}

    def google_available(self) -> bool:
        if not self.configured:
            return False
        now = time.monotonic()
        if self._provider_cache is None or now - self._provider_cache[0] >= 60:
            providers = self.providers_transport().get("external", {})
            self._provider_cache = (now, isinstance(providers, dict) and providers.get("google") is True)
        return self._provider_cache[1]

    def _request_owner(self, token: str) -> dict[str, Any]:
        return self._post_json(self.url + "/rest/v1/rpc/owner_account_stats", {}, token)

    def _owner_summary(self) -> dict[str, Any]:
        if not self.access_token:
            raise VaultError("Sign in to view owner statistics.", 401)
        summary = self.owner_transport(self.access_token)
        if not isinstance(summary, dict) or summary.get("owner") is not True:
            raise VaultError("Owner access is required.", 403)
        return summary

    @staticmethod
    def _request_usage(token: str) -> dict[str, Any]:
        # Fixed application-controlled HTTPS origin. Never forward account tokens to
        # arbitrary statistics endpoints configured for anonymous telemetry.
        request = Request("https://memory-map-stats.memory-map-app.workers.dev/owner/stats",
                          headers={"Authorization": "Bearer " + token, "Accept": "application/json",
                                   "User-Agent": f"MemoryMap/{VERSION}"})
        try:
            with build_opener(NoRedirect).open(request, timeout=10) as response:
                result = json.loads(response.read(512 * 1024))
        except (HTTPError, URLError, OSError, ValueError):
            raise VaultError("Usage statistics service is unavailable.", 503) from None
        if not isinstance(result, dict):
            raise VaultError("Usage statistics service returned an invalid response.", 503)
        return result

    def owner_stats(self) -> dict[str, Any]:
        summary = self._owner_summary()
        accounts = {key: max(0, value) for key in ("registered", "confirmed", "newLast7", "signedInLast30")
                    if type(value := summary.get(key)) is int}
        usage = None
        try:
            usage = self.usage_transport(self.access_token)
        except VaultError:
            pass
        return {"accounts": accounts, "usage": usage}

    @staticmethod
    def _credentials(email: Any, password: Any, *, register: bool) -> dict[str, str]:
        if not isinstance(email, str) or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email.strip()) or len(email) > 254:
            raise VaultError("Enter a valid email address.")
        if not isinstance(password, str) or not (12 if register else 1) <= len(password) <= 128:
            raise VaultError("Enter an account password." if not register else "Use an account password of at least 12 characters.")
        return {"email": email.strip(), "password": password}

    def _accept(self, result: dict[str, Any]) -> bool:
        user = result.get("user")
        access = result.get("access_token")
        if not isinstance(user, dict) or not isinstance(access, str) or not access or not isinstance(user.get("id"), str):
            return False
        email = user.get("email")
        if not isinstance(email, str) or not user.get("email_confirmed_at"):
            return False
        self.user = {"id": user["id"], "email": email}
        self.access_token = access
        self.message = "Signed in."
        return True

    def email(self, email: Any, password: Any, *, register: bool) -> dict[str, Any]:
        self._require()
        credentials = self._credentials(email, password, register=register)
        if register:
            self.transport("signup?" + urlencode({"redirect_to": self.site_url}), credentials)
            # The provider verifies mailbox ownership before any sign-in is accepted.
            self.message = "Check your email for a confirmation link, then sign in."
        elif not self._accept(self.transport("token?grant_type=password", credentials)):
            raise VaultError("Confirm your email before signing in.", 401)
        return self.status()

    def begin_google(self, origin: str) -> str:
        self._require()
        if not self.google_available():
            raise VaultError("Google sign-in is not enabled on the account service yet.", 503)
        verifier = secrets.token_urlsafe(48)
        nonce = secrets.token_urlsafe(24)
        self.oauth = (nonce, verifier, time.monotonic() + 300)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        redirect = f"{origin}/account/callback?nonce={nonce}"
        return self.url + "/auth/v1/authorize?" + urlencode({
            "provider": "google", "redirect_to": redirect,
            "code_challenge": challenge, "code_challenge_method": "s256",
        })

    def finish_google(self, nonce: str, code: str) -> bool:
        pending = self.oauth
        if (not pending or not nonce or not secrets.compare_digest(nonce, pending[0])
                or not code or len(code) > 4096 or time.monotonic() > pending[2]):
            raise VaultError("Sign-in attempt expired. Start again.", 400)
        self.oauth = None
        result = self.transport("token?grant_type=pkce", {"auth_code": code, "code_verifier": pending[1]})
        if not self._accept(result):
            raise VaultError("Google account could not be verified.", 401)
        return True

    def sign_out(self) -> dict[str, Any]:
        token = self.access_token
        self.reset()
        if token:
            try:
                self.transport("logout?scope=local", {}, token)
            except VaultError:
                # Credentials are invalidated locally even when the network is unavailable.
                pass
        return self.status()
