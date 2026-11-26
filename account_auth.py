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


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class AccountClient:
    def __init__(self, url: str, key: str, site_url: str, *, transport: Callable | None = None):
        self.url = url.rstrip("/")
        self.key = key
        parts = urlsplit(self.url)
        self.configured = bool(parts.scheme == "https" and parts.hostname
                               and parts.hostname.endswith(".supabase.co")
                               and not parts.username and not parts.password and not parts.path
                               and not parts.query and not parts.fragment and key.startswith("sb_publishable_"))
        self.site_url = site_url
        self.transport = transport or self._request
        self.reset()

    def reset(self) -> None:
        self.user: dict[str, str] = {}
        self.access_token = ""
        self.oauth: tuple[str, str, float] | None = None
        self.message = ""

    def status(self) -> dict[str, Any]:
        return {"configured": self.configured, "user": self.user.copy(),
                "message": self.message}

    def _require(self) -> None:
        if not self.configured:
            raise VaultError("Online account service is not configured.", 503)

    def _request(self, path: str, body: dict[str, Any], token: str = "") -> dict[str, Any]:
        self._require()
        headers = {"apikey": self.key, "Content-Type": "application/json", "Accept": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        request = Request(self.url + "/auth/v1/" + path, method="POST", headers=headers,
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
