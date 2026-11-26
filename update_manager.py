"""Opt-in desktop updates from the app's configured GitHub Releases.

A verified binary is staged in private app storage. The original executable
remains a launcher and starts the staged version on a subsequent launch.
"""
from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any, Callable
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAX_DOWNLOAD = 500 * 1024 * 1024
REPO_PATTERN = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
TAG_PATTERN = re.compile(r"v(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?")
DIGEST_PATTERN = re.compile(r"sha256:([a-f0-9]{64})")
RELEASE_HOSTS = {"github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"}


def version_tuple(value: Any) -> tuple[int, ...]:
    match = TAG_PATTERN.fullmatch(value) if isinstance(value, str) else None
    return tuple(int(part or 0) for part in match.groups()) if match else ()


def asset_name(system: str = sys.platform, machine: str = platform.machine()) -> str:
    arch = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(machine.lower())
    name = {"darwin": "macos", "win32": "windows", "linux": "linux"}.get(system)
    if not arch or not name or (name == "windows" and arch != "x64"):
        return ""
    return f"MemoryMap-{name}-{arch}" + (".exe" if name == "windows" else ".bin")


def release_asset(data: dict[str, Any], repo: str, current: str, name: str) -> dict[str, Any] | None:
    tag = data.get("tag_name")
    if (not REPO_PATTERN.fullmatch(repo) or not name or not version_tuple(current)
            or version_tuple(tag) <= version_tuple(current) or data.get("draft") or data.get("prerelease")):
        return None
    assets = data.get("assets")
    if not isinstance(assets, list):
        return None
    for asset in assets:
        if not isinstance(asset, dict) or asset.get("name") != name or asset.get("state") != "uploaded":
            continue
        digest = DIGEST_PATTERN.fullmatch(str(asset.get("digest", "")))
        size = asset.get("size")
        url = asset.get("browser_download_url")
        expected_url = f"https://github.com/{repo}/releases/download/{tag}/{name}"
        if digest and type(size) is int and 0 < size <= MAX_DOWNLOAD and url == expected_url:
            return {"tag": tag, "name": name, "digest": digest[1], "size": size, "url": url}
    return None


class ReleaseRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parts = urlsplit(newurl)
        if parts.scheme != "https" or parts.hostname not in RELEASE_HOSTS or parts.username or parts.password:
            raise URLError("Invalid release redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_release(repo: str) -> dict[str, Any]:
    if not REPO_PATTERN.fullmatch(repo):
        return {}
    request = Request(f"https://api.github.com/repos/{repo}/releases/latest",
                      headers={"Accept": "application/vnd.github+json", "User-Agent": "MemoryMap-Updater"})
    with build_opener(ReleaseRedirect).open(request, timeout=15) as response:
        raw = response.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError("Release metadata is too large")
    value = json.loads(raw)
    return value if isinstance(value, dict) else {}


def valid_binary(path: Path, asset: dict[str, Any]) -> bool:
    try:
        if not path.is_file() or path.is_symlink() or path.stat().st_size != asset["size"]:
            return False
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            while chunk := stream.read(128 * 1024):
                digest.update(chunk)
        return digest.hexdigest() == asset["digest"]
    except (OSError, KeyError):
        return False


def download_asset(asset: dict[str, Any], destination: Path) -> None:
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=destination.parent, prefix=".download-")
    temp = Path(tmp)
    digest = hashlib.sha256()
    try:
        request = Request(asset["url"], headers={"User-Agent": "MemoryMap-Updater"})
        count = 0
        with os.fdopen(fd, "wb") as output, build_opener(ReleaseRedirect).open(request, timeout=30) as response:
            while chunk := response.read(128 * 1024):
                count += len(chunk)
                if count > asset["size"]:
                    raise ValueError("Release size changed")
                digest.update(chunk)
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        if count != asset["size"] or digest.hexdigest() != asset["digest"]:
            raise ValueError("Release checksum mismatch")
        temp.chmod(0o700)
        os.replace(temp, destination)
    finally:
        temp.unlink(missing_ok=True)


class UpdateManager:
    def __init__(self, folder: Path, repo: str, version: str, *, name: str | None = None,
                 fetch: Callable[[str], dict[str, Any]] = fetch_release,
                 download: Callable[[dict[str, Any], Path], None] = download_asset) -> None:
        self.folder, self.repo, self.version = folder, repo, version
        self.name = (asset_name() if getattr(sys, "frozen", False) else "") if name is None else name
        self.fetch, self.download = fetch, download
        self.lock = threading.RLock()
        self.busy = False
        self.message = ""
        self.config = self._load()

    def _load(self) -> dict[str, Any]:
        try:
            value = json.loads((self.folder / "update.json").read_text(encoding="utf-8"))
            if isinstance(value, dict) and value.get("repo") == self.repo:
                return value
        except (OSError, ValueError):
            pass
        return {"repo": self.repo, "enabled": False}

    def _save(self) -> None:
        self.folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix=".update-", dir=self.folder)
        tmp = Path(name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(self.config, stream, separators=(",", ":"))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(tmp, self.folder / "update.json")
        finally:
            tmp.unlink(missing_ok=True)

    def _pending(self) -> tuple[Path, dict[str, Any]] | None:
        asset = self.config.get("pending")
        if not isinstance(asset, dict):
            return None
        tag, name, digest, size = (asset.get(key) for key in ("tag", "name", "digest", "size"))
        if (not version_tuple(tag) or version_tuple(tag) <= version_tuple(self.version) or name != self.name
                or not self.name or not DIGEST_PATTERN.fullmatch("sha256:" + str(digest))
                or type(size) is not int or not 0 < size <= MAX_DOWNLOAD):
            return None
        return self.folder / tag / name, asset

    def status(self) -> dict[str, Any]:
        with self.lock:
            pending = self._pending()
            return {"supported": bool(self.name and REPO_PATTERN.fullmatch(self.repo)),
                    "enabled": self.config.get("enabled") is True, "busy": self.busy,
                    "staged": pending[1]["tag"] if pending else "", "message": self.message,
                    "current": self.version}

    def configure(self, enabled: bool) -> dict[str, Any]:
        if type(enabled) is not bool:
            raise ValueError("Choose whether to enable automatic updates")
        with self.lock:
            if not self.name or not REPO_PATTERN.fullmatch(self.repo):
                raise ValueError("Automatic updates require an installed desktop build")
            self.config["enabled"] = enabled
            self._save()
        if enabled:
            self.check()
        return self.status()

    def check(self) -> None:
        with self.lock:
            if not self.name or not self.config.get("enabled") or self.busy:
                return
            self.busy = True
        threading.Thread(target=self._stage, daemon=True).start()

    def _stage(self) -> None:
        try:
            asset = release_asset(self.fetch(self.repo), self.repo, self.version, self.name)
            if asset is None:
                with self.lock:
                    self.message = "No verified newer desktop build is available."
                return
            destination = self.folder / asset["tag"] / self.name
            if not valid_binary(destination, asset):
                self.download(asset, destination)
            if not valid_binary(destination, asset):
                raise ValueError("Release checksum mismatch")
            with self.lock:
                if self.config.get("enabled"):
                    self.config["pending"] = asset
                    self._save()
                    self.message = "Update verified. It will open on the next app launch."
        except (OSError, ValueError, URLError):
            with self.lock:
                self.message = "Update download failed. You can try again or use GitHub Releases."
        finally:
            with self.lock:
                self.busy = False

    def launch_pending(self, args: list[str]) -> bool:
        if not self.config.get("enabled") or not REPO_PATTERN.fullmatch(self.repo):
            return False
        pending = self._pending()
        if pending is None or not valid_binary(*pending):
            return False
        executable, _asset = pending
        try:
            subprocess.Popen([str(executable), *args], close_fds=True,
                             env={**os.environ, "PYINSTALLER_RESET_ENVIRONMENT": "1"})
        except OSError:
            return False
        return True
