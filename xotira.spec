# PyInstaller recipe: one self-contained "Memory map" program (no Python install needed on the user's machine).
#   pip install pyinstaller -r requirements-desktop.txt && pyinstaller xotira.spec
# Build on each target OS (Windows, macOS, Linux); PyInstaller cannot cross-compile.
import sys
import os
from PyInstaller.utils.hooks import collect_submodules, collect_dynamic_libs, collect_data_files

hidden = collect_submodules("cryptography.hazmat.primitives.kdf") + ["yaml"]

voice_data = []
voice_binaries = []
if sys.platform == "linux":
    voice_data = [("models/voice-en", "models/voice-en")]
    voice_binaries = collect_dynamic_libs("vosk")
elif sys.platform == "darwin":
    hidden += ["Speech", "AVFoundation", "PyObjCTools.AppHelper"]

version = None
if sys.platform == "win32":  # publisher shown in the file's Properties and in Windows' security prompt (once signed)
    from PyInstaller.utils.win32.versioninfo import (FixedFileInfo, StringFileInfo, StringStruct, StringTable,
                                                     VarFileInfo, VarStruct, VSVersionInfo)
    version = VSVersionInfo(
        ffi=FixedFileInfo(filevers=(47, 0, 0, 0), prodvers=(47, 0, 0, 0)),
        kids=[StringFileInfo([StringTable("040904B0", [
            StringStruct("CompanyName", "Nurmuhammad"), StringStruct("FileDescription", "Memory map"),
            StringStruct("ProductName", "Memory map"), StringStruct("ProductVersion", "47"),
            StringStruct("LegalCopyright", "Nurmuhammad"), StringStruct("OriginalFilename", "MemoryMap.exe")])]),
              VarFileInfo([VarStruct("Translation", [1033, 1200])])])

a = Analysis(
    ["app.py"],
    pathex=["."],
    datas=[("web", "web"), ("brain_bridge.py", "."), ("ai/prompts", "ai/prompts")] + collect_data_files("certifi") + voice_data,
    binaries=voice_binaries,
    hiddenimports=hidden,
    excludes=["tkinter", "unittest", "pydoc"],
)
pyz = PYZ(a.pure)
mac_identity = os.environ.get("APPLE_SIGN_IDENTITY") if sys.platform == "darwin" and os.environ.get("APPLE_CERT_BASE64") else None
exe = EXE(pyz, a.scripts, a.binaries, a.datas, [], name="MemoryMap", console=True, upx=False,
          codesign_identity=mac_identity,
          **({"version": version, "icon": "assets/memory-map.ico"} if version else {}))

# macOS uses a conventional windowed one-directory bundle. Keep the separate
# one-file executable above for the existing desktop update protocol.
if sys.platform == "darwin":
    app_exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="MemoryMapGUI",
                  console=False, upx=False, codesign_identity=mac_identity)
    app_dir = COLLECT(app_exe, a.binaries, a.datas, strip=False, upx=False, name="MemoryMapGUI")
    app_bundle = BUNDLE(app_dir, name="Memory map.app", icon="assets/memory-map.icns",
                        bundle_identifier="com.memorymap.app", version="47.0",
                        info_plist={"CFBundleDisplayName": "Memory map", "CFBundleName": "Memory map",
                                    "CFBundleVersion": "47", "NSHighResolutionCapable": True,
                                    "NSMicrophoneUsageDescription": "Memory map uses your microphone when you choose Voice to dictate a note.",
                                    "NSSpeechRecognitionUsageDescription": "Memory map converts your speech to note text when you choose Voice."})
