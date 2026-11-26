"""Anonymous usage statistics — strictly opt-in, counts only, never content.

What can be sent is a fixed list (see PING_KEYS, FEATURES, MILESTONES). Note titles, text, tags, file names,
passwords and IP addresses are never part of it, and the user can preview the exact payload at any time.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import urlsplit
from uuid import uuid4

import settings
from vault import Vault, VaultError

VERSION = "v38"
FEATURES = ("home", "graph", "mindmap", "mindmap_view", "databases", "calendar", "roadmaps", "flashcards", "templates",
            "study", "daily", "search", "backup", "transfer", "import", "share", "publish_host", "attachments",
            "tasks", "clipper", "ai_agent", "ai_export")
MILESTONES = ("vault_created", "first_note", "first_link", "backup_made", "shared_transfer", "published_local",
              "published_host")
LANGS = ("en", "uz", "ru", "tr", "es", "ar")
PING_KEYS = ("v", "install_id", "version", "platform", "lang", "notes", "linked", "features", "milestones")
RETRY_SECONDS = 600
FEEDBACK_KINDS = ("bug", "idea", "other")
_UNSET = object()

ROUTE_FEATURES: tuple[tuple[re.Pattern[str], str, str | None], ...] = (
    (re.compile(r"/api/mind-maps"), "mindmap", None),
    (re.compile(r"/api/search"), "search", None),
    (re.compile(r"/api/backup"), "backup", "backup_made"),
    (re.compile(r"/api/transfer/(?:export|import)"), "transfer", "shared_transfer"),
    (re.compile(r"/api/import/.*"), "import", None),
    (re.compile(r"/api/notes/[0-9a-f]{32}/share"), "share", None),
    (re.compile(r"/api/notes/[0-9a-f]{32}/host"), "publish_host", None),
    (re.compile(r"/api/notes/[0-9a-f]{32}/files"), "attachments", None),
    (re.compile(r"/api/(?:tasks|reminders)"), "tasks", None),
    (re.compile(r"/api/(?:clip|tools/bibtex)"), "clipper", None),
    (re.compile(r"/api/review-agent|/api/agent/.*"), "ai_agent", None),
    (re.compile(r"/api/export/brain"), "ai_export", None),
)


def bucket(count: int) -> str:
    return "0" if count <= 0 else "1-9" if count < 10 else "10-49" if count < 50 else "50-199" if count < 200 else "200+"


def platform_name() -> str:
    if os.environ.get("MEMORY_MAP_ANDROID") == "1":
        return "android"
    return {"win32": "windows", "darwin": "macos"}.get(sys.platform, "linux")


def valid_endpoint(url: str) -> str:
    parts = urlsplit((url or "").strip())
    local = parts.hostname in ("127.0.0.1", "localhost", "::1")
    if (parts.scheme == "https" or (parts.scheme == "http" and local)) and parts.hostname and not (
            parts.username or parts.password or parts.query or parts.fragment or parts.path.strip("/")):
        return f"{parts.scheme}://{parts.netloc}"
    return ""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


def http_post(url: str, payload: dict[str, Any]) -> bool:
    request = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "User-Agent": f"MemoryMap/{VERSION}"})
    try:
        with urllib.request.build_opener(_NoRedirect).open(request, timeout=8) as response:
            return 200 <= response.status < 300
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        return False


class Telemetry:
    def __init__(self, vault: Vault, endpoint: str, *, version: str = VERSION, platform: str | None = None,
                 post: Callable[[str, dict[str, Any]], bool] = http_post, now: Callable[[], float] = time.time,
                 require_consent: bool = True) -> None:
        self.vault, self.endpoint = vault, valid_endpoint(endpoint)
        self.require_consent = require_consent
        self.version, self.platform, self._post, self._now = version, platform or platform_name(), post, now
        self.features: set[str] = set()
        self.milestones: set[str] = set()
        self.lang = "en"
        self._last_attempt = 0.0
        self._result: tuple[bool, str] | None = None
        self._sending = False
        self._consent: Any = _UNSET

    # ---- state (encrypted inside the vault) ---------------------------------------------------
    def _state(self) -> dict[str, Any]:
        return settings.load(self.vault, "telemetry", {"consent": None})

    def blocked(self) -> bool:
        """Testing builds with a statistics address require the user's agreement before the app can be used."""
        if not self.require_consent or not self.endpoint or self.vault.cipher is None:
            return False
        if self._consent is _UNSET:
            self._consent = self._state().get("consent")
        return self._consent is not True

    def status(self) -> dict[str, Any]:
        state = self._state()
        consent = state.get("consent")
        self._consent = consent
        return {"available": bool(self.endpoint), "required": self.require_consent, "consent": consent,
                "preview": self.payload(state) if consent is True else self.example()}

    def set_consent(self, value: Any) -> dict[str, Any]:
        if not isinstance(value, bool):
            raise VaultError("Choose yes or no.")
        if not self.endpoint:
            raise VaultError("Statistics are not available in this build.", 409)
        state = self._state()
        if value:
            state = {"consent": True, "installId": state.get("installId") or uuid4().hex, "lastPing": "",
                     "milestones": state.get("milestones", [])}
            self.features.clear()  # nothing counted before the user agreed is ever sent
            self.milestones.clear()
        else:
            if state.get("installId"):  # erase what the server already has, best effort
                threading.Thread(target=self._post, args=(self.endpoint + "/v1/forget", {"install_id": state["installId"]}),
                                 daemon=True).start()
            state = {"consent": False}
            self.features.clear()
            self.milestones.clear()
        settings.save(self.vault, "telemetry", state)
        self._consent = state["consent"]
        self._last_attempt = 0.0
        return self.status()

    def send_feedback(self, kind: Any, message: Any, contact: Any = "", screenshot: Any = "") -> None:
        if not self.endpoint:
            raise VaultError("Feedback is not available in this build.", 409)
        state = self._state()
        if state.get("consent") is not True or not state.get("installId"):
            raise VaultError("Agree to anonymous statistics first.", 428)
        contact = contact.strip() if isinstance(contact, str) else ""
        if (kind not in FEEDBACK_KINDS or not isinstance(message, str) or not 5 <= len(message.strip()) <= 2000
                or len(contact) > 120):
            raise VaultError("Write a message of 5–2000 characters.")
        if screenshot is None:
            screenshot = ""
        if not isinstance(screenshot, str) or len(screenshot) > 1_333_365:
            raise VaultError("Screenshot must be a PNG, JPEG or WebP up to 1 MB.")
        if screenshot:
            match = re.fullmatch(r"data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})", screenshot)
            if not match:
                raise VaultError("Screenshot must be a PNG, JPEG or WebP up to 1 MB.")
            try:
                image = base64.b64decode(match[2], validate=True)
            except binascii.Error:
                raise VaultError("Screenshot contains invalid image data.") from None
            kind_of_image = match[1]
            signature_matches = (
                image.startswith(b"\x89PNG\r\n\x1a\n") if kind_of_image == "png"
                else image.startswith(b"\xff\xd8\xff") if kind_of_image == "jpeg"
                else image.startswith(b"RIFF") and image[8:12] == b"WEBP"
            )
            if len(image) > 1_000_000 or not signature_matches:
                raise VaultError("Screenshot must be a PNG, JPEG or WebP up to 1 MB.")
        payload: dict[str, Any] = {
            "v": 1, "install_id": state["installId"], "kind": kind, "message": message.strip(), "contact": contact,
            "version": self.version, "platform": self.platform, "lang": self.lang,
        }
        if screenshot:
            payload["screenshot"] = screenshot
        if not self._post(self.endpoint + "/v1/feedback", payload):
            raise VaultError("Could not send the message. Check your internet connection and try again.", 502)

    # ---- what is counted ----------------------------------------------------------------------
    def observe(self, route: str, post: bool) -> None:
        for pattern, feature, milestone in ROUTE_FEATURES:
            if pattern.fullmatch(route):
                self.features.add(feature)
                if milestone and (post or route == "/api/backup"):
                    self.milestones.add(milestone)
                return

    def feature(self, name: Any, lang: Any = None) -> None:
        if name in FEATURES:
            self.features.add(name)
        if lang in LANGS:
            self.lang = lang

    def example(self) -> dict[str, Any]:
        return {"v": 1, "install_id": "(created after you agree)", "version": self.version, "platform": self.platform,
                "lang": self.lang, "notes": "1-9", "linked": False, "features": ["graph"], "milestones": ["first_note"]}

    def payload(self, state: dict[str, Any] | None = None) -> dict[str, Any]:
        state = state or self._state()
        active = [note for note in self.vault.notes.values() if not note.trashed and not note.storage_only]
        linked = any("](xotira:" in note.body or "[[" in note.body for note in active)
        reached = set(state.get("milestones", [])) | self.milestones | {"vault_created"}
        if active:
            reached.add("first_note")
        if linked:
            reached.add("first_link")
        if self._has_public_page():
            reached.add("published_local")
        if self._has_hosted_page():
            reached.add("published_host")
        result = {"v": 1, "install_id": state.get("installId", ""), "version": self.version, "platform": self.platform,
                  "lang": self.lang, "notes": bucket(len(active)), "linked": linked,
                  "features": sorted(self.features & set(FEATURES)), "milestones": sorted(reached & set(MILESTONES))}
        if state.get("consent") is True and settings.load(self.vault, "ai_settings", {}).get("shareCounts") is True:
            from ai.proposals import usage
            totals = usage(self.vault)
            result["ai_counts"] = {key: min(totals[key], 1_000_000) for key in ("requests", "approvals")}
        return result

    def _has_public_page(self) -> bool:
        try:
            from public_share import list_public_shares
            return bool(list_public_shares(self.vault))
        except Exception:
            return False

    def _has_hosted_page(self) -> bool:
        try:
            return bool(settings.load(self.vault, "hosting_pages", {}))
        except Exception:
            return False

    # ---- sending ------------------------------------------------------------------------------
    def tick(self) -> None:
        """Called on every request: sends at most one ping per day, never blocks the app."""
        if self.vault.cipher is None:
            self._consent = _UNSET
        if not self.endpoint or self.vault.cipher is None:
            return
        if self._result is not None:
            ok, day = self._result
            self._result, self._sending = None, False
            if ok:
                state = self._state()
                state.update({"lastPing": day, "milestones": sorted(set(state.get("milestones", [])) | self.milestones)})
                settings.save(self.vault, "telemetry", state)
                self.features.clear()
        state = self._state()
        day = datetime.fromtimestamp(self._now(), timezone.utc).strftime("%Y-%m-%d")
        if (state.get("consent") is not True or state.get("lastPing") == day or self._sending
                or self._now() - self._last_attempt < RETRY_SECONDS):
            return
        self._last_attempt, self._sending = self._now(), True
        payload = self.payload(state)
        threading.Thread(target=self._send, args=(payload, day), daemon=True).start()

    def _send(self, payload: dict[str, Any], day: str) -> None:
        self._result = (self._post(self.endpoint + "/v1/ping", payload), day)


_UPDATE_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def _version_tuple(tag: str) -> tuple[int, int, int] | None:
    match = re.fullmatch(r"v?(\d{1,8})(?:\.(\d{1,8}))?(?:\.(\d{1,8}))?", tag, re.I)
    if not match:
        return None
    major, minor, patch = (int(part or 0) for part in match.groups())
    return major, minor, patch


def _http_get_json(url: str) -> dict[str, Any] | None:
    request = urllib.request.Request(
        url, method="GET",
        headers={"Accept": "application/vnd.github+json", "User-Agent": f"MemoryMap/{VERSION}"},
    )
    try:
        with urllib.request.build_opener(_NoRedirect).open(request, timeout=5) as response:
            if 200 <= response.status < 300:
                data = json.loads(response.read().decode("utf-8"))
                return data if isinstance(data, dict) else None
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        return None
    return None


def check_for_updates(
    repo: str,
    current: str = VERSION,
    *,
    fetch_json: Callable[[str], dict[str, Any] | None] = _http_get_json,
    now: Callable[[], float] = time.time,
    ttl_seconds: int = 3600,
) -> dict[str, Any]:
    clean_repo = (repo or "").strip()
    base = {"available": False, "current": current, "latest": "", "url": "", "configured": bool(clean_repo)}
    if not _REPO_RE.fullmatch(clean_repo):
        return base
    ts = now()
    cached = _UPDATE_CACHE.get(clean_repo)
    if cached and cached[1]["current"] == current and ts - cached[0] < ttl_seconds:
        return cached[1].copy()
    data = fetch_json(f"https://api.github.com/repos/{clean_repo}/releases/latest")
    if not data:
        return base
    tag = str(data.get("tag_name") or "").strip()
    html_url = str(data.get("html_url") or "").strip()
    release_root = f"https://github.com/{clean_repo}/releases"
    if not html_url.lower().startswith(release_root.lower() + "/tag/"):
        html_url = release_root
    installed, released = _version_tuple(current), _version_tuple(tag)
    available = installed is not None and released is not None and released > installed
    result = {"available": available, "current": current, "latest": tag, "url": html_url, "configured": True}
    _UPDATE_CACHE[clean_repo] = (ts, result.copy())
    return result
