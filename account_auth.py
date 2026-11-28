"""Verified Google identity, independent of local encrypted notes."""
from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
import socket
import ssl
import time
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request

from secure_transport import verified_opener
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
        self.oauth_url = ""
        self.oauth_error = ""
        self.message = ""
        self.is_owner = False
        self.google_session = False
        self.refresh_token = ""
        self.expires_at = 0.0
        self.refresh_retry_at = 0.0

    def authorized(self) -> bool:
        if not self.google_session or not self.access_token:
            return False
        now = time.monotonic()
        if now < self.expires_at - 30 or (now < self.expires_at and now < self.refresh_retry_at):
            return True
        if self.refresh_token:
            try:
                result = self.transport("token?grant_type=refresh_token", {"refresh_token": self.refresh_token})
                user = result.get("user")
                if isinstance(user, dict) and user.get("id") == self.user.get("id") and self._accept_google(result):
                    return True
            except VaultError as error:
                # A temporary connection error does not invalidate a still-valid
                # access token. Retry briefly, but never authorize past expiry.
                if error.status in (429, 503) and time.monotonic() < self.expires_at:
                    self.refresh_retry_at = min(self.expires_at, time.monotonic()+5)
                    return True
            except (TypeError, ValueError):
                pass
        self.reset()
        self.message = "Your Google session expired. Sign in again."
        return False

    def _accept_google(self, result: dict[str, Any]) -> bool:
        user = result.get("user")
        metadata = user.get("app_metadata", {}) if isinstance(user, dict) else {}
        if not isinstance(metadata, dict):
            return False
        providers = metadata.get("providers", [])
        if metadata.get("provider") != "google" and not (isinstance(providers, list) and "google" in providers):
            return False
        lifetime = result.get("expires_in")
        refresh = result.get("refresh_token")
        if type(lifetime) not in (int, float) or not 30 < lifetime <= 86400 or not isinstance(refresh, str) or not refresh:
            return False
        if not self._accept(result):
            return False
        self.google_session = True
        self.refresh_token = refresh
        self.expires_at = time.monotonic() + lifetime
        self.refresh_retry_at = 0.0
        return True

    def status(self) -> dict[str, Any]:
        self.is_owner = False
        if self.access_token:
            try:
                self.is_owner = self._owner_summary().get("owner") is True
            except VaultError:
                # Owner access is never inferred from a local email or cached after a failed check.
                self.is_owner = False
        return {"configured": self.configured, "user": self.user.copy(),
                "message": self.message, "owner": self.is_owner, "authenticated": self.google_session,
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
            with verified_opener(NoRedirect).open(request, timeout=12) as response:
                raw = response.read(256 * 1024)
            result = json.loads(raw) if raw else {}
        except HTTPError as error:
            # Inspect only the provider's machine-readable error code. Never log
            # response bodies, authorization codes, tokens, or user information.
            try:
                detail = json.loads(error.read(16384))
                code = detail.get("error_code", "") if isinstance(detail, dict) else ""
                if not isinstance(code, str):
                    code = ""
            except (OSError, ValueError, TypeError):
                code = ""
            if error.code == 429:
                raise VaultError("Too many sign-in requests. Wait a moment and try again.", 429) from None
            if code in {"flow_state_expired", "flow_state_not_found", "bad_code_verifier", "validation_failed"} or error.code in (400, 422):
                raise VaultError("The sign-in code expired or was rejected. Sign in with Google again.", 400) from None
            if error.code in (401, 403):
                raise VaultError("The account service rejected the request. Check your account or app configuration and try again.", 401) from None
            raise VaultError(f"Account service returned HTTP {error.code}. Try signing in again.", 503) from None
        except (URLError, OSError, ValueError) as error:
            reason = error.reason if isinstance(error, URLError) else error
            if isinstance(reason, ssl.SSLCertVerificationError):
                message = "Could not verify the account service's HTTPS certificate. Check your system date, network and app version."
            elif isinstance(reason, (TimeoutError, socket.timeout)):
                message = "The account service timed out. Check your connection and sign in again."
            elif isinstance(reason, socket.gaierror):
                message = "Could not reach the account service. Check your internet connection and DNS."
            else:
                message = "Could not connect to the account service securely. Check your internet connection and sign in again."
            raise VaultError(message, 503) from None
        return result if isinstance(result, dict) else {}

    def _request_providers(self) -> dict[str, Any]:
        self._require()
        request = Request(self.url + "/auth/v1/settings",
                          headers={"apikey": self.key, "Accept": "application/json",
                                   "User-Agent": f"MemoryMap/{VERSION}"})
        try:
            with verified_opener(NoRedirect).open(request, timeout=15) as response:
                result = json.loads(response.read(128 * 1024))
        except (HTTPError, URLError, OSError, ValueError):
            return {}
        return result if isinstance(result, dict) else {}

    def google_available(self) -> bool | None:
        """Distinguish a disabled provider from a temporarily unavailable lookup."""
        if not self.configured:
            return False
        now = time.monotonic()
        if self._provider_cache is not None and now - self._provider_cache[0] < 60:
            return self._provider_cache[1]
        providers = self.providers_transport().get("external", {})
        enabled = providers.get("google") if isinstance(providers, dict) else None
        if type(enabled) is bool:
            self._provider_cache = (time.monotonic(), enabled)
            return enabled
        # A timeout or malformed result is not a negative provider capability.
        return None

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
            with verified_opener(NoRedirect).open(request, timeout=10) as response:
                result = json.loads(response.read(512 * 1024))
        except HTTPError as error:
            if error.code in (401, 403):
                raise VaultError("The usage service could not verify owner access. Account counts above are live.", 503) from None
            raise VaultError(f"The usage service returned HTTP {error.code}. Account counts above are live.", 503) from None
        except (URLError, OSError, ValueError):
            raise VaultError("Could not connect to the usage service. Account counts above are live.", 503) from None
        if not isinstance(result, dict):
            raise VaultError("Usage statistics service returned an invalid response.", 503)
        return result

    def owner_stats(self) -> dict[str, Any]:
        summary = self._owner_summary()
        accounts = {key: max(0, value) for key in ("registered", "confirmed", "newLast7", "signedInLast30")
                    if type(value := summary.get(key)) is int}
        try:
            usage = self.usage_transport(self.access_token)
        except VaultError as error:
            return {"accounts": accounts, "usage": None, "usageError": str(error)}
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

    def _prepare_google(self, origin: str) -> str:
        self._require()
        verifier = secrets.token_urlsafe(48)
        nonce = secrets.token_urlsafe(24)
        # Allow users time to finish Google account selection or MFA. Supabase
        # independently enforces the much shorter, one-time auth code lifetime.
        self.oauth = (nonce, verifier, time.monotonic() + 900)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        redirect = f"{origin}/account/callback?nonce={nonce}"
        self.oauth_url = self.url + "/auth/v1/authorize?" + urlencode({
            "provider": "google", "redirect_to": redirect,
            "code_challenge": challenge, "code_challenge_method": "s256",
        })
        return self.oauth_url

    def google_login(self, origin: str) -> dict[str, str]:
        """Prepare the real link before a click, preserving the native user gesture."""
        if self.google_session:
            return {"url": "", "message": ""}
        if not self.configured:
            return {"url": "", "message": "Online account service is not configured."}
        if self.oauth is None or time.monotonic() >= self.oauth[2]:
            if self.oauth is not None:
                self.oauth_error = "Your sign-in attempt expired. Click Sign in with Google again."
            self._prepare_google(origin)
        return {"url": self.oauth_url, "message": self.oauth_error or self.message}

    def begin_google(self, origin: str) -> str:
        self._require()
        if self.google_available() is False:
            raise VaultError("Google sign-in is not enabled on the account service yet.", 503)
        self.oauth_error = ""
        return self._prepare_google(origin)

    def finish_google(self, nonce: str, code: str, *, provider_error: str = "") -> bool:
        pending = self.oauth
        if not pending or not nonce or not secrets.compare_digest(nonce, pending[0]):
            # A stale or foreign callback must not cancel the current attempt.
            raise VaultError("This sign-in attempt is no longer active. Return to Memory map.", 400)
        self.oauth = None
        self.oauth_url = ""
        try:
            if time.monotonic() > pending[2]:
                raise VaultError("Sign-in attempt expired. Click Sign in with Google again.", 400)
            if provider_error:
                if provider_error in {"access_denied", "user_cancelled"}:
                    raise VaultError("Google sign-in was cancelled. You can try again.", 400)
                raise VaultError("Google did not complete sign-in. Check your account and try again.", 400)
            if not code or len(code) > 4096:
                raise VaultError("Google did not return an authorization code. Try signing in again.", 400)
            result = self.transport("token?grant_type=pkce", {"auth_code": code, "code_verifier": pending[1]})
            if not self._accept_google(result):
                raise VaultError("Google account could not be verified. Sign in again.", 401)
        except VaultError as error:
            self.oauth_error = str(error)
            raise
        self.oauth_error = ""
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
