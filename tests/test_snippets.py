"""Check local code execution, vault authorization, and runner isolation."""

from __future__ import annotations

import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Any

from app import Server

from account_fixture import fixture_account
from snippet_runner import MAX_OUTPUT, SnippetError, resource, run_snippet
from vault import Vault


class SnippetTests(unittest.TestCase):
    @unittest.skipIf(resource is None, "Python Run requires process resource limits")
    def test_python_output_and_simple_function(self) -> None:
        result = run_snippet("python", 'print("olma")')
        self.assertEqual(result, {"output": "olma\n", "error": "", "truncated": False})
        source = "def square(x):\n    return x ** 2\n\nfor x in range(3):\n    print(square(x))"
        self.assertEqual(run_snippet("python", source)["output"], "0\n1\n4\n")

    @unittest.skipIf(resource is None, "Python Run requires process resource limits")
    def test_limits_and_partial_output(self) -> None:
        self.assertIn("Import", run_snippet("python", "import math")["error"])
        self.assertIn("Attribute", run_snippet("python", "print('olma'.upper())")["error"])
        result = run_snippet("python", 'print("first")\nprint(1 / 0)')
        self.assertEqual(result["output"], "first\n")
        self.assertIn("division by zero", result["error"])
        result = run_snippet("python", 'print("x" * 13000)')
        self.assertTrue(result["truncated"])
        self.assertEqual(len(result["output"]), MAX_OUTPUT)
        result = run_snippet("python", "while True:\n    x = 1")
        self.assertIn("limit", result["error"])
        with self.assertRaises(SnippetError):
            run_snippet("javascript", 'console.log("olma")')
        with self.assertRaises(SnippetError):
            run_snippet("python", "print(" + "x" * 20_000 + ")")

    def test_sql_is_fresh_and_restricts_database_files(self) -> None:
        source = """CREATE TABLE produce(name TEXT);
INSERT INTO produce VALUES ('olma');
SELECT name FROM produce"""
        self.assertEqual(run_snippet("sql", source)["output"], "name\nolma\n")
        self.assertIn("no such table", run_snippet("sql", "SELECT name FROM produce")["error"])
        self.assertIn("not authorized", run_snippet("sql", "ATTACH DATABASE 'example.sqlite3' AS external")["error"])

    def test_http_checks_vault_authentication_and_request_body(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            vault = Vault(Path(folder) / "test.xotira")
            with Server(vault, None, account=fixture_account()) as server:
                thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
                thread.start()
                try:
                    snippet = {"language": "sql", "source": "SELECT 2 + 3 AS total"}
                    self.assertEqual(self.request(server, snippet, authenticated=False)[0], 401)
                    self.assertEqual(self.request(server, snippet)[0], 423)
                    vault.unlock("snippet-tests-password", create=True)
                    self.assertEqual(self.request(server, snippet)[1]["output"], "total\n5\n")
                    self.assertEqual(self.request(server, {"language": "python", "source": []})[0], 400)
                finally:
                    server.shutdown()
                    thread.join()

    @staticmethod
    def request(server: Server, snippet: dict[str, Any], *,
                authenticated: bool = True) -> tuple[int, dict[str, Any]]:
        headers = {"Content-Type": "application/json", "Origin": server.origin}
        if authenticated:
            headers["Authorization"] = f"Bearer {server.token}"
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        try:
            connection.request("POST", "/api/snippets/run", json.dumps(snippet), headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()
