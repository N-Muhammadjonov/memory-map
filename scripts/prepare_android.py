"""Copy only application code and web assets into the generated Android package."""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parent.parent
target = root / "android/app/src/main/python/memorymap_runtime"
target.mkdir(parents=True, exist_ok=True)
(target / "__init__.py").touch()
for item in root.glob("*.py"):
    shutil.copy2(item, target / item.name)
for folder in ("web", "ai"):
    shutil.copytree(root / folder, target / folder, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
