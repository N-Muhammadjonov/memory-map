@echo off
setlocal
cd /d "%~dp0"

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY (
    echo Install Python 3.10 or later from https://www.python.org/downloads/windows/ ^(tick "Add python.exe to PATH"^).
    pause
    exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
    %PY% -m venv .venv || (echo Could not create the virtual environment. & pause & exit /b 1)
)
".venv\Scripts\python.exe" -c "import yaml; from cryptography.hazmat.primitives.kdf.argon2 import Argon2id" >nul 2>nul
if errorlevel 1 (
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt || (echo Could not install the requirements. & pause & exit /b 1)
)
".venv\Scripts\python.exe" app.py %*
if errorlevel 1 pause
