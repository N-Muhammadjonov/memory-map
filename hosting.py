"""Publish a single note to a public host you control (see publish_server.py).

The local app renders the page itself (public_share.py) and uploads only that finished HTML. The host
never sees the vault, other notes or your passwords. The host address and key are stored encrypted
inside the vault. If a note is trashed or unpublished, its hosted copy is removed (retried until it works).
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit

from public_share import configure_note_share, export_static_public_html, get_note_share_status
from vault import Vault, VaultError

MIN_LOCK_PASSWORD = 10  # a locked hosted page is public ciphertext: it can be attacked offline
TOKEN_CHARS = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


from settings import load as _load, save as _save  # noqa: E402


def check_endpoint(url: Any, key: Any) -> dict[str, str]:
    if not isinstance(url, str) or not isinstance(key, str) or not 16 <= len(key) <= 256 or not key.isprintable():
        raise VaultError("Enter the publish server address and a key of at least 16 characters.")
    parts = urlsplit(url.strip())
    local = parts.hostname in ("127.0.0.1", "localhost", "::1")
    if (parts.scheme not in ("https", "http") or (parts.scheme == "http" and not local) or not parts.hostname
            or parts.username or parts.password or parts.query or parts.fragment or parts.path.strip("/")):
        raise VaultError("Use an https:// address (http:// only for localhost), without a path or login.")
    return {"url": f"{parts.scheme}://{parts.netloc}", "key": key}


def config_status(vault: Vault) -> dict[str, Any]:
    config = _load(vault, "hosting_config", None)
    return {"configured": bool(config), "server": config["url"] if config else ""}


def set_config(vault: Vault, url: Any, key: Any, clear: bool = False) -> dict[str, Any]:
    if clear:
        _save(vault, "hosting_config", None)
    else:
        _save(vault, "hosting_config", check_endpoint(url, key))
    return config_status(vault)


def _remote(vault: Vault, method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    config = _load(vault, "hosting_config", None)
    if not config:
        raise VaultError("Set the publish server first.", 409)
    body = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(config["url"] + path, data=body, method=method, headers={
        "Authorization": "Bearer " + config["key"], "Content-Type": "application/json", "User-Agent": "MemoryMap/30"})
    try:
        with urllib.request.build_opener(_NoRedirect).open(request, timeout=20) as response:
            return json.loads(response.read(1024 * 1024) or b"{}")
    except urllib.error.HTTPError as error:
        message = {401: "The publish server rejected the key.", 404: "That hosted page no longer exists.",
                   413: "The page is too large for the publish server."}
        raise VaultError(message.get(error.code, f"Publish server error {error.code}."), 502 if error.code != 404 else 404) from error
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as error:
        raise VaultError("Could not reach the publish server.", 502) from error


def page_status(vault: Vault, note_id: str) -> dict[str, Any]:
    pages = _load(vault, "hosting_pages", {})
    page = pages.get(note_id)
    return {**config_status(vault), "hosted": bool(page), "hostedUrl": page["url"] if page else "",
            "hostedLocked": bool(page and page["locked"]), "hostedAt": page["updated"] if page else "",
            "pendingRemovals": len(_load(vault, "hosting_pending", []))}


def publish(vault: Vault, note_id: str, password: Any = "") -> dict[str, Any]:
    if password and (not isinstance(password, str) or not MIN_LOCK_PASSWORD <= len(password) <= 128):
        raise VaultError(f"A password lock on a public host needs {MIN_LOCK_PASSWORD}–128 characters.")
    current = get_note_share_status(vault, note_id)
    if not current["enabled"]:
        raise VaultError("Turn on “Publish this note” and save sharing first.", 409)
    # refresh the snapshot so the host gets the current text of this one note
    configure_note_share(vault, note_id, {"enabled": True, "theme": current["theme"], "slug": current["slug"]})
    _, html = export_static_public_html(vault, note_id, static_password=password or "")
    locked = bool(password)
    pages = _load(vault, "hosting_pages", {})
    existing = pages.get(note_id)
    payload = {"html": html.decode("utf-8"), "locked": locked}
    try:
        result = _remote(vault, "PUT", f"/api/pages/{existing['token']}", payload) if existing else None
    except VaultError as error:
        if error.status != 404:
            raise
        result = None
    if result is None:
        result = _remote(vault, "POST", "/api/pages", payload)
    token = result.get("token", "")
    if not token or set(token) - TOKEN_CHARS or not str(result.get("url", "")).startswith(("http://", "https://")):
        raise VaultError("The publish server sent an unexpected answer.", 502)
    pages[note_id] = {"token": token, "url": result["url"], "locked": locked,
                      "updated": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    _save(vault, "hosting_pages", pages)
    return page_status(vault, note_id)


def unhost(vault: Vault, note_ids: list[str]) -> list[str]:
    """Remove hosted copies. Failures are remembered and retried, so a trashed note cannot stay online unnoticed."""
    pages = _load(vault, "hosting_pages", {})
    pending = _load(vault, "hosting_pending", [])
    changed = False
    for note_id in note_ids:
        page = pages.pop(note_id, None)
        if page:
            pending.append(page["token"])
            changed = True
    if changed:
        _save(vault, "hosting_pages", pages)
    remaining = []
    for token in dict.fromkeys(pending):
        try:
            _remote(vault, "DELETE", f"/api/pages/{token}")
        except VaultError as error:
            if error.status != 404:
                remaining.append(token)
    if remaining != pending or changed:
        _save(vault, "hosting_pending", remaining)
    return remaining
