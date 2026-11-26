#!/bin/sh
set -eu
cd "$(dirname "$0")"
VENV=".venv"

PYTHON_BIN=""
for candidate in \
    /opt/homebrew/bin/python3.14 \
    /opt/homebrew/bin/python3.13 \
    /opt/homebrew/bin/python3.12 \
    /opt/homebrew/bin/python3.11 \
    /opt/homebrew/bin/python3.10 \
    /usr/local/bin/python3.14 \
    /usr/local/bin/python3.13 \
    /usr/local/bin/python3.12 \
    /usr/local/bin/python3 \
    python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
        if "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
            PYTHON_BIN="$candidate"
            break
        fi
    fi
done

if [ -z "$PYTHON_BIN" ]; then
    printf '%s\n' 'Install Python 3.10 or later from https://www.python.org/downloads/macos/.'
    exit 1
fi

if [ ! -x "$VENV/bin/python" ]; then
    "$PYTHON_BIN" -m venv "$VENV"
fi
if ! "$VENV/bin/python" -c 'import yaml; from cryptography.hazmat.primitives.kdf.argon2 import Argon2id' 2>/dev/null; then
    "$VENV/bin/python" -m pip install -r requirements.txt
fi
exec "$VENV/bin/python" app.py "$@"
