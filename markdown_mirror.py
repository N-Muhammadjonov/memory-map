"""Live Markdown folder mirror: continuously mirrors active vault notes to a plain .md folder."""

from __future__ import annotations

import hashlib
import json
import os
import posixpath
import re
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

import settings
from vault import Vault, VaultError, map_wikilinks, title_key

MANIFEST_NAME = ".xotira-mirror.json"
EXPORT_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _safe_stem(name: str) -> str:
    return EXPORT_NAME.sub("_", name).strip(" .")[:100] or "Note"


def _validate_dir(raw_path: Any) -> Path:
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise VaultError("Enter a valid folder path for the Markdown mirror.")
    p = Path(raw_path.strip()).expanduser()
    if p.is_symlink():
        raise VaultError("Symbolic links are not allowed as mirror folders.")
    if p.exists() and not p.is_dir():
        raise VaultError("The mirror path must be a folder, not a file.")
    resolved = p.resolve()
    forbidden = {Path("/"), Path("/System"), Path("/bin"), Path("/sbin"), Path("/usr"), Path("/etc")}
    if resolved in forbidden:
        raise VaultError("Choose a user folder for the Markdown mirror.")
    return resolved


def get_config(vault: Vault) -> dict[str, Any]:
    vault.require_unlocked(touch=False)
    cfg = settings.load(vault, "markdown_mirror", {"dir": "", "enabled": False, "lastSync": "", "files": 0})
    return {
        "dir": str(cfg.get("dir") or ""),
        "enabled": bool(cfg.get("enabled")),
        "lastSync": str(cfg.get("lastSync") or ""),
        "files": int(cfg.get("files") or 0),
    }


def set_config(vault: Vault, directory: Any, enabled: Any) -> dict[str, Any]:
    vault.require_unlocked()
    if not isinstance(enabled, bool):
        raise VaultError("Choose whether automatic mirroring is enabled.")
    clean_dir = ""
    if enabled or (isinstance(directory, str) and directory.strip()):
        target = _validate_dir(directory)
        target.mkdir(parents=True, exist_ok=True)
        clean_dir = str(target)
    prev = get_config(vault)
    next_cfg = {
        "dir": clean_dir,
        "enabled": enabled and bool(clean_dir),
        "lastSync": prev["lastSync"],
        "files": prev["files"],
    }
    settings.save(vault, "markdown_mirror", next_cfg)
    return next_cfg


def sync_mirror(vault: Vault, override_dir: Path | None = None) -> dict[str, Any]:
    vault.require_unlocked(touch=False)
    cfg = get_config(vault)
    raw_dir = str(override_dir) if override_dir is not None else cfg["dir"]
    if not raw_dir:
        raise VaultError("Configure a Markdown mirror folder first.")
    root = _validate_dir(raw_dir)
    root.mkdir(parents=True, exist_ok=True)

    protected = vault.protected_note_ids()
    notes = [n for n in vault.notes.values() if not n.trashed and not n.storage_only and n.id not in protected]
    names: dict[str, str] = {}
    lookup: dict[str, str] = {}
    used: set[str] = set()
    for note in notes:
        base = _safe_stem(note.title)
        label = base
        number = 2
        while title_key(label) in used:
            label = f"{base} ({number})"
            number += 1
        used.add(title_key(label))
        names[note.id] = label
        lookup.update((title_key(name), label) for name in [note.title, *note.aliases])

    output_paths = {note.id: f"{note.source}/{note.path}" if note.path else f"{names[note.id]}.md" for note in notes}
    written: dict[str, str] = {}
    attachment_paths: dict[str, str] = {}
    manifest_path = _mirror_path(root, MANIFEST_NAME)
    owner = vault.vault_id.hex()
    previous = {}
    if manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text("utf-8"))
        except (OSError, ValueError) as error:
            raise VaultError("The mirror manifest could not be read.", 409) from error
        if isinstance(manifest, dict) and manifest.get("vault") == owner and isinstance(manifest.get("files"), dict):
            previous = manifest["files"]
        elif not isinstance(manifest, list):
            raise VaultError("Choose a mirror folder belonging to this vault.", 409)
        # Old manifests contain only paths. Existing matching files can be adopted by hash.

    with tempfile.TemporaryDirectory(prefix=".xotira-stage-", dir=root) as directory:
        staging = Path(directory)
        used_paths: dict[str, str] = {}
        def write_output(relative: str, data: bytes) -> None:
            path = _mirror_path(root, relative)
            key = relative.casefold()
            digest = hashlib.sha256(data).hexdigest()
            if key in used_paths and (used_paths[key] != relative or written[relative] != digest):
                raise VaultError(f"Two mirror items use the same path: {relative}", 409)
            if path.is_file():
                current = _file_digest(path)
                if current not in (digest, previous.get(relative)):
                    raise VaultError(f"An existing file differs from the mirror: {relative}", 409)
            if not path.is_file() or current != digest:
                staged = staging / relative
                staged.parent.mkdir(parents=True, exist_ok=True)
                staged.write_bytes(data)
            used_paths[key] = relative
            written[relative] = digest

        for item in vault.list_attachments():
            if item["noteId"] in protected:
                continue
            if item.get("managed"):
                _, contents = vault.attachment(item["noteId"], item["id"])
                asset = f"{item['source']}/{item['path']}"
                write_output(asset, contents)
            else:
                asset = f"assets/{item['id']}/{_safe_stem(item['name'])}"
            attachment_paths[item["id"]] = asset

        for note in notes:
            def replace_link(match: re.Match[str]) -> str:
                original = match.group(1)
                target = lookup.get(title_key(original))
                if target is None or target == original.strip():
                    return match.group(0)
                return "[[" + target + match.group(0)[2 + len(original):]

            rel_path = output_paths[note.id]
            text = note.body if note.path else map_wikilinks(note.body, replace_link)

            def replace_stable(match: re.Match[str]) -> str:
                paths = output_paths if match[1] == "xotira" else attachment_paths
                target = paths.get(match[2])
                if not target:
                    return match[0]
                relative = posixpath.relpath(target, posixpath.dirname(rel_path) or ".")
                return "](" + quote(relative, safe="/") + ")"

            text = re.sub(r"\]\((xotira|attachment):([0-9a-f]{32})\)", replace_stable, text)
            files = vault.get_note(note.id, resolve=False)["attachments"]
            links = []
            for file in files:
                name, contents = vault.attachment(note.id, file["id"])
                asset_path = attachment_paths[file["id"]]
                write_output(asset_path, contents)
                display = name.replace("[", "(").replace("]", ")")
                relative = posixpath.relpath(asset_path, posixpath.dirname(rel_path) or ".")
                links.append(f"- [{display}]({quote(relative, safe='/')})")
            if links:
                text += "\n\n## Attachments\n\n" + "\n".join(links) + "\n"
            write_output(rel_path, text.encode("utf-8"))

        stale = []
        for relative, digest in previous.items():
            if relative.casefold() in used_paths or relative == MANIFEST_NAME:
                continue
            old = _mirror_path(root, relative)
            if old.is_file() and _file_digest(old) == digest:
                stale.append(old)
        for relative in written:
            staged = staging / relative
            if staged.is_file():
                target = _mirror_path(root, relative)
                target.parent.mkdir(parents=True, exist_ok=True)
                os.replace(staged, target)
        for old in stale:
            old.unlink()
        _write_file(manifest_path, json.dumps(
            {"vault": owner, "files": written}, ensure_ascii=False, sort_keys=True, indent=2
        ).encode("utf-8"))
    now_str = datetime.now().isoformat(timespec="seconds")
    updated_cfg = {
        "dir": str(root),
        "enabled": cfg["enabled"] if override_dir is None else True,
        "lastSync": now_str,
        "files": len(written),
    }
    if override_dir is None:
        settings.save(vault, "markdown_mirror", updated_cfg)
    return updated_cfg


def _mirror_path(root: Path, relative: str) -> Path:
    parts = relative.split("/")
    if any(not part or part in (".", "..") or "\\" in part or ":" in part for part in parts):
        raise VaultError("The mirror contains an invalid file path.", 409)
    path = root
    for part in parts:
        path = path / part
        if path.is_symlink():
            raise VaultError(f"The mirror path contains a symbolic link: {relative}", 409)
    return path


def _file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_file(dest: Path, data: bytes) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.is_file() and _file_digest(dest) == hashlib.sha256(data).hexdigest():
        return
    with tempfile.NamedTemporaryFile(dir=dest.parent, delete=False) as file:
        tmp = Path(file.name)
        try:
            file.write(data)
        except BaseException:
            file.close()
            tmp.unlink(missing_ok=True)
            raise
    try:
        os.replace(tmp, dest)
    finally:
        tmp.unlink(missing_ok=True)
