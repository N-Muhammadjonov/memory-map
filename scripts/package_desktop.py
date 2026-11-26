"""Pack a smoke-tested executable for one platform and architecture."""
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tarfile

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
    subprocess.run(["ditto", "-c", "-k", "--keepParent", str(app), str(out / (name + ".zip"))], check=True)
    shutil.copy2(binary, out / (name + ".bin"))
else:
    with tarfile.open(out / (name + ".tar.gz"), "w:gz") as archive:
        archive.add(binary, arcname="MemoryMap")
    shutil.copy2(binary, out / (name + ".bin"))
