# PyInstaller recipe: one self-contained "Memory map" program (no Python install needed on the user's machine).
#   pip install pyinstaller -r requirements-desktop.txt && pyinstaller xotira.spec
# Build on each target OS (Windows, macOS, Linux); PyInstaller cannot cross-compile.
import sys
from PyInstaller.utils.hooks import collect_submodules

hidden = collect_submodules("cryptography.hazmat.primitives.kdf") + ["yaml"]

version = None
if sys.platform == "win32":  # publisher shown in the file's Properties and in Windows' security prompt (once signed)
    from PyInstaller.utils.win32.versioninfo import (FixedFileInfo, StringFileInfo, StringStruct, StringTable,
                                                     VarFileInfo, VarStruct, VSVersionInfo)
    version = VSVersionInfo(
        ffi=FixedFileInfo(filevers=(42, 0, 0, 0), prodvers=(42, 0, 0, 0)),
        kids=[StringFileInfo([StringTable("040904B0", [
            StringStruct("CompanyName", "Nurmuhammad"), StringStruct("FileDescription", "Memory map"),
            StringStruct("ProductName", "Memory map"), StringStruct("ProductVersion", "42"),
            StringStruct("LegalCopyright", "Nurmuhammad"), StringStruct("OriginalFilename", "MemoryMap.exe")])]),
              VarFileInfo([VarStruct("Translation", [1033, 1200])])])

a = Analysis(
    ["app.py"],
    pathex=["."],
    datas=[("web", "web"), ("brain_bridge.py", "."), ("ai/prompts", "ai/prompts")],
    hiddenimports=hidden,
    excludes=["tkinter", "unittest", "pydoc"],
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, a.binaries, a.datas, [], name="MemoryMap", console=True, upx=False,
          **({"version": version} if version else {}))
