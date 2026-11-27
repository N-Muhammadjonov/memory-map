"""Pack a smoke-tested executable for one platform and architecture."""
from pathlib import Path
import hashlib
import os
import plistlib
import shutil
import subprocess
import sys
import tarfile
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from telemetry import VERSION

name, binary_path = sys.argv[1:3]
binary = Path(binary_path)
out = Path("out")
out.mkdir(exist_ok=True)
if "windows" in name:
    shutil.copy2(binary, out / (name + ".exe"))
elif "macos" in name:
    app = Path("dist") / "Memory map.app"
    launch = app / "Contents" / "MacOS"
    launch.mkdir(parents=True, exist_ok=True)
    shutil.copy2(binary, launch / "MemoryMap")
    with (app / "Contents" / "Info.plist").open("wb") as stream:
        plistlib.dump({
            "CFBundleExecutable": "MemoryMap",
            "CFBundleDisplayName": "Memory map",
            "CFBundleName": "Memory map",
            "CFBundleIdentifier": "com.memorymap.app",
            "CFBundlePackageType": "APPL",
            "CFBundleInfoDictionaryVersion": "6.0",
            "CFBundleShortVersionString": VERSION.removeprefix("v") + ".0",
            "CFBundleVersion": VERSION.removeprefix("v"),
            "NSHighResolutionCapable": True,
        }, stream)
    package = (out / (name + ".dmg")).resolve()
    sign = os.environ.get("APPLE_SIGN_IDENTITY")
    publisher_configured = bool(os.environ.get("APPLE_CERT_BASE64") and sign)
    if publisher_configured:
        subprocess.run(["codesign", "--force", "--options", "runtime", "--timestamp", "--sign", sign, str(app)], check=True)
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
    # Disk image contains the exact application bundle and an Applications shortcut.
    with tempfile.TemporaryDirectory(prefix="memory-map-dmg-") as tmp:
        staging = Path(tmp) / "image"
        staging.mkdir()
        subprocess.run(["ditto", str(app), str(staging / app.name)], check=True)
        (staging / "Applications").symlink_to("/Applications", target_is_directory=True)
        subprocess.run(["hdiutil", "create", "-volname", "Memory Map", "-srcfolder", str(staging),
                        "-fs", "HFS+", "-format", "UDZO", "-ov", str(package)], check=True)
        if publisher_configured:
            subprocess.run(["codesign", "--force", "--timestamp", "--sign", sign, str(package)], check=True)
            subprocess.run(["xcrun", "notarytool", "submit", str(package), "--apple-id", os.environ["APPLE_ID"],
                            "--team-id", os.environ["APPLE_TEAM_ID"], "--password", os.environ["APPLE_APP_PASSWORD"], "--wait"], check=True)
            subprocess.run(["xcrun", "stapler", "staple", str(package)], check=True)
            subprocess.run(["xcrun", "stapler", "validate", str(package)], check=True)
        # Verify the actual compressed image, not just the staged files.
        subprocess.run(["hdiutil", "verify", str(package)], check=True)
        mount = Path(tmp) / "mounted"
        mount.mkdir()
        subprocess.run(["hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", str(mount), str(package)], check=True)
        try:
            mounted_app = mount / app.name
            mounted_binary = mounted_app / "Contents" / "MacOS" / "MemoryMap"
            assert mounted_binary.is_file() and os.access(mounted_binary, os.X_OK), "Missing executable in DMG"
            assert (mount / "Applications").is_symlink() and os.readlink(mount / "Applications") == "/Applications", "Missing Applications shortcut"
            assert (mounted_app / "Contents" / "Info.plist").read_bytes() == (app / "Contents" / "Info.plist").read_bytes(), "Bundle metadata changed in DMG"
            with mounted_binary.open("rb") as packed, (launch / "MemoryMap").open("rb") as original:
                assert hashlib.file_digest(packed, "sha256").digest() == hashlib.file_digest(original, "sha256").digest(), "Executable changed in DMG"
            if publisher_configured:
                subprocess.run(["codesign", "--verify", "--deep", "--strict", str(mounted_app)], check=True)
            print(f"PASS: {package.name} mounts, bundle and executable match, Applications shortcut present")
        finally:
            subprocess.run(["hdiutil", "detach", str(mount)], check=True)
    shutil.copy2(binary, out / (name + ".bin"))
else:
    with tarfile.open(out / (name + ".tar.gz"), "w:gz") as archive:
        archive.add(binary, arcname="MemoryMap")
    shutil.copy2(binary, out / (name + ".bin"))
