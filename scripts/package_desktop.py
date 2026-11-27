"""Pack a smoke-tested executable for one platform and architecture."""
from pathlib import Path
import hashlib
import json
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
    # Use the standard windowed PyInstaller BUNDLE, not a manually wrapped
    # single-file executable. Its Frameworks and Resources are sealed together.
    with (app / "Contents" / "Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    executable = info["CFBundleExecutable"]
    launch = app / "Contents" / "MacOS" / executable
    assert launch.is_file() and os.access(launch, os.X_OK), "Missing macOS bundle executable"
    assert (app / "Contents" / "Frameworks").is_dir(), "Missing bundled native frameworks"
    assert info["CFBundleIdentifier"] == "com.memorymap.app"
    assert info["CFBundleShortVersionString"] == VERSION.removeprefix("v") + ".0"
    icon = info["CFBundleIconFile"]
    if not icon.endswith(".icns"):
        icon += ".icns"
    resources = app / "Contents" / "Resources"
    assert (resources / icon).is_file(), "Missing app icon"
    package = (out / (name + ".dmg")).resolve()
    sign = os.environ.get("APPLE_SIGN_IDENTITY")
    publisher_configured = bool(os.environ.get("APPLE_CERT_BASE64") and sign)
    # PyInstaller signs the complete app bundle with its nested code before distribution.
    subprocess.run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app)], check=True)
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
            notarization = subprocess.run(["xcrun", "notarytool", "submit", str(package), "--apple-id", os.environ["APPLE_ID"],
                            "--team-id", os.environ["APPLE_TEAM_ID"], "--password", os.environ["APPLE_APP_PASSWORD"], "--wait", "--output-format", "json"],
                            check=True, capture_output=True, text=True)
            assert json.loads(notarization.stdout)["status"] == "Accepted", "Apple notarization was not accepted"
            subprocess.run(["xcrun", "stapler", "staple", str(package)], check=True)
            subprocess.run(["xcrun", "stapler", "validate", str(package)], check=True)
        # Verify the actual compressed image, not just the staged files.
        subprocess.run(["hdiutil", "verify", str(package)], check=True)
        mount = Path(tmp) / "mounted"
        mount.mkdir()
        subprocess.run(["hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", str(mount), str(package)], check=True)
        try:
            mounted_app = mount / app.name
            mounted_binary = mounted_app / "Contents" / "MacOS" / executable
            assert mounted_binary.is_file() and os.access(mounted_binary, os.X_OK), "Missing executable in DMG"
            assert (mount / "Applications").is_symlink() and os.readlink(mount / "Applications") == "/Applications", "Missing Applications shortcut"
            assert (mounted_app / "Contents" / "Info.plist").read_bytes() == (app / "Contents" / "Info.plist").read_bytes(), "Bundle metadata changed in DMG"
            with mounted_binary.open("rb") as packed, launch.open("rb") as original:
                assert hashlib.file_digest(packed, "sha256").digest() == hashlib.file_digest(original, "sha256").digest(), "Executable changed in DMG"
            assert (mounted_app / "Contents" / "Resources" / icon).read_bytes() == (resources / icon).read_bytes(), "App icon missing or changed in DMG"
            subprocess.run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(mounted_app)], check=True)
            if publisher_configured:
                subprocess.run(["spctl", "--assess", "--type", "execute", "--verbose=2", str(mounted_app)], check=True)
            else:
                print("Bundle seal validated; Developer ID publisher/notarization verification is not configured.")
            # Exercise the actual Finder/LaunchServices launch from a copied DMG bundle.
            installed = Path(tmp) / "installed" / app.name
            installed.parent.mkdir()
            subprocess.run(["ditto", str(mounted_app), str(installed)], check=True)
            subprocess.run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(installed)], check=True)
            subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / "tests" / "smoke_macos_bundle.py"), str(installed)], check=True, timeout=150)
            print(f"PASS: {package.name} mounts, bundle and executable match, Applications shortcut present")
        finally:
            subprocess.run(["hdiutil", "detach", str(mount)], check=True)
    shutil.copy2(binary, out / (name + ".bin"))
else:
    with tarfile.open(out / (name + ".tar.gz"), "w:gz") as archive:
        archive.add(binary, arcname="MemoryMap")
    shutil.copy2(binary, out / (name + ".bin"))
