"""Test-only launch entrypoint, preserving all production vault checks."""
from pathlib import Path
import sys
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from account_fixture import fixture_account
import app

if __name__ == "__main__":
    with patch("app.AccountClient", return_value=fixture_account()):
        app.main()
