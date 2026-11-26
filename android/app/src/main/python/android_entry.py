"""Start the same authenticated loopback server in Android's foreground service."""
from __future__ import annotations
import os
from pathlib import Path
import sys
import threading

os.environ["MEMORY_MAP_ANDROID"] = "1"

import memorymap_runtime

sys.path.insert(0, str(Path(memorymap_runtime.__file__).parent))
from app import Server, Vault

_server = None
_lock = None
_thread = None


def start(folder: str) -> str:
    global _server, _lock, _thread
    if _server is not None:
        return _server.origin + "/#" + _server.token
    directory = Path(folder).resolve()
    vault = Vault(directory / "MemoryMap.xotira")
    lock = vault.process_lock()
    lock.__enter__()
    try:
        server = Server(vault, None)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
    except BaseException:
        lock.__exit__(*sys.exc_info())
        raise
    _server, _lock, _thread = server, lock, thread
    return server.origin + "/#" + server.token


def stop() -> None:
    global _server, _lock, _thread
    if _server is None:
        return
    _server.shutdown()
    _thread.join(5)
    _server.vault.lock()
    _server.server_close()
    _lock.__exit__(None, None, None)
    _server = _lock = _thread = None
