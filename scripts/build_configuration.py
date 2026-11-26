"""Bake only public configuration into software distributions."""
from pathlib import Path
import os

source = Path("build_config.py")
values = {
    "STATS_URL": os.environ.get("XOTIRA_STATS_URL", ""),
    "GITHUB_REPO": os.environ.get("XOTIRA_GITHUB_REPO", ""),
    "AUTH_URL": os.environ.get("XOTIRA_AUTH_URL", ""),
    "AUTH_KEY": os.environ.get("XOTIRA_AUTH_KEY", ""),
    "AUTH_SITE_URL": os.environ.get("XOTIRA_AUTH_SITE_URL", ""),
}
if values["AUTH_KEY"] and not values["AUTH_KEY"].startswith("sb_publishable_"):
    raise ValueError("Only a publishable Supabase key may be included in client builds.")
with source.open("a", encoding="utf-8") as output:
    for name, value in values.items():
        if value:
            output.write(f"\n{name} = {value!r}\n")
