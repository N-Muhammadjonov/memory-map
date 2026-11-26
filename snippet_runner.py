"""Local runner for bounded Python and temporary SQLite snippets."""

from __future__ import annotations

import ast
import builtins
import io
import json
import math
import operator
import os
import re
import sqlite3
import subprocess
import symtable
import sys
import tempfile
import time
from pathlib import Path
from threading import BoundedSemaphore
from typing import Any

try:
    import resource
except ImportError:
    resource = None

MAX_SOURCE = 16_384
MAX_OUTPUT = 12_000
MAX_SEQUENCE = 20_000
MAX_INT_BITS = 1024
MAX_AST_NODES = 2200
TIMEOUT_SECONDS = 3
LANGUAGES = {"python", "sql"}
PYTHON_BUILTINS = ("abs", "all", "any", "bool", "dict", "divmod", "enumerate", "float", "int",
                   "len", "list", "max", "min", "reversed", "round", "set", "sorted", "str",
                   "sum", "tuple", "zip")
PYTHON_NAMES = {*PYTHON_BUILTINS, "print", "range", "sqrt", "sin", "cos"}
WORKERS = BoundedSemaphore(2)


class SnippetError(ValueError):
    """Raised when a snippet exceeds the supported language subset or limits."""


AST_TYPES = {
    ast.Module, ast.Expr, ast.Constant, ast.Name, ast.Load, ast.Store,
    ast.List, ast.Tuple, ast.Set, ast.Dict, ast.Assign, ast.AugAssign,
    ast.BinOp, ast.UnaryOp, ast.BoolOp, ast.Compare, ast.If, ast.IfExp,
    ast.For, ast.While, ast.Subscript, ast.Slice, ast.Call, ast.keyword,
    ast.FunctionDef, ast.arguments, ast.arg, ast.Return, ast.Pass, ast.Break,
    ast.Continue, ast.JoinedStr, ast.FormattedValue,
    ast.And, ast.Or, ast.Not, ast.UAdd, ast.USub, ast.Add, ast.Sub, ast.Mult,
    ast.Div, ast.FloorDiv, ast.Mod, ast.Pow, ast.Eq, ast.NotEq, ast.Lt, ast.LtE,
    ast.Gt, ast.GtE, ast.In, ast.NotIn, ast.Is, ast.IsNot,
}
OPERATORS = {
    "Add": operator.add, "Sub": operator.sub, "Mult": operator.mul, "Div": operator.truediv,
    "FloorDiv": operator.floordiv, "Mod": operator.mod, "Pow": operator.pow,
}


class Output:
    def __init__(self) -> None:
        self.stream = io.StringIO()
        self.truncated = False

    def write(self, text: str) -> None:
        remaining = MAX_OUTPUT - self.stream.tell()
        self.stream.write(text[:remaining])
        if len(text) > remaining:
            self.truncated = True
            raise SnippetError("Output limit reached.")

    def print(self, *args: Any, sep: str = " ", end: str = "\n") -> None:
        if not isinstance(sep, str) or not isinstance(end, str):
            raise TypeError("sep and end must be strings.")
        for index, value in enumerate(args):
            if index:
                self.write(sep)
            self.write(str(value))
        self.write(end)

    def result(self, error: str = "") -> dict[str, Any]:
        return {"output": self.stream.getvalue(), "error": error, "truncated": self.truncated}


def limited_value(value: Any) -> Any:
    if type(value) is int and value.bit_length() > MAX_INT_BITS:
        raise SnippetError("Integer limit reached.")
    if isinstance(value, (str, list, tuple)) and len(value) > MAX_SEQUENCE:
        raise SnippetError("Value length limit reached.")
    return value


def binary(kind: str, first: Any, second: Any) -> Any:
    if kind == "Mod" and isinstance(first, str):
        raise SnippetError("Use print arguments or simple f-strings for formatting.")
    if kind == "Pow" and (type(second) not in (int, float) or abs(second) > MAX_INT_BITS):
        raise SnippetError("Exponent limit reached.")
    if kind == "Mult":
        for sequence, factor in ((first, second), (second, first)):
            if isinstance(sequence, (str, list, tuple)) and type(factor) is int:
                if len(sequence) * max(0, factor) > MAX_SEQUENCE:
                    raise SnippetError("Value length limit reached.")
    return limited_value(OPERATORS[kind](first, second))


def compact_range(*args: int) -> range:
    for value in args:
        if type(value) is not int or abs(value) > 1_000_000:
            raise SnippetError("Range endpoints must be small integers.")
    result = range(*args)
    if len(result) > MAX_SEQUENCE:
        raise SnippetError("Range length limit reached.")
    return result


class CheckedCode(ast.NodeTransformer):
    def visit_BinOp(self, node: ast.BinOp) -> ast.AST:
        return ast.copy_location(ast.Call(
            func=ast.Name(id="_xotira_binary", ctx=ast.Load()),
            args=[ast.Constant(type(node.op).__name__), self.visit(node.left), self.visit(node.right)],
            keywords=[],
        ), node)

    def visit_AugAssign(self, node: ast.AugAssign) -> ast.AST:
        if not isinstance(node.target, ast.Name):
            raise SnippetError("Use augmented assignment with a variable.")
        expression = ast.BinOp(left=ast.Name(node.target.id, ast.Load()), op=node.op, right=node.value)
        return ast.copy_location(ast.Assign(targets=[node.target], value=self.visit_BinOp(expression)), node)


def check_python(source: str) -> ast.Module:
    tree = ast.parse(source)
    if not tree.body:
        raise SnippetError("Enter a Python statement.")
    for count, node in enumerate(ast.walk(tree), 1):
        if count > MAX_AST_NODES:
            raise SnippetError("The snippet is too complex.")
        if type(node) not in AST_TYPES:
            name = type(node).__name__
            raise SnippetError(f"{name} is unavailable in the snippet runner.")
        if isinstance(node, (ast.Name, ast.arg, ast.FunctionDef)):
            name = node.id if isinstance(node, ast.Name) else node.arg if isinstance(node, ast.arg) else node.name
            if name.startswith("_"):
                raise SnippetError("Names starting with an underscore are unavailable.")
        if isinstance(node, ast.Constant):
            if type(node.value) not in (str, bool, int, float, type(None)):
                raise SnippetError("Use text, numbers, booleans, or None.")
            limited_value(node.value)
        if isinstance(node, ast.FormattedValue) and node.format_spec is not None:
            raise SnippetError("F-string width and precision specifiers are unavailable.")
        if isinstance(node, ast.FunctionDef) and (node.decorator_list or node.returns or getattr(node, "type_params", ())):
            raise SnippetError("Use simple functions without decorators or type parameters.")
    root = symtable.symtable(source, "<snippet>", "exec")
    defined = PYTHON_NAMES | {name.get_name() for name in root.get_symbols()
                             if name.is_assigned() or name.is_namespace()}
    tables = [root]
    while tables:
        scope = tables.pop()
        for symbol in scope.get_symbols():
            if symbol.is_referenced() and symbol.is_global() and symbol.get_name() not in defined:
                raise SnippetError(f"{symbol.get_name()} is unavailable in the snippet runner.")
        tables.extend(scope.get_children())
    return ast.fix_missing_locations(CheckedCode().visit(tree))


def run_python(source: str, output: Output) -> None:
    tree = check_python(source)
    allowed = {name: getattr(builtins, name) for name in PYTHON_BUILTINS}
    allowed.update(print=output.print, range=compact_range, sqrt=math.sqrt, sin=math.sin, cos=math.cos)
    namespace = {"__builtins__": allowed, "_xotira_binary": binary}
    # Run only the validated AST and its internal arithmetic guards.
    exec(compile(tree, "<snippet>", "exec"), namespace)


SQL_ACTIONS = {
    sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_INSERT, sqlite3.SQLITE_CREATE_TABLE,
    sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE, sqlite3.SQLITE_TRANSACTION,
}
SQL_FUNCTIONS = {
    "abs", "avg", "coalesce", "count", "date", "datetime", "glob", "ifnull", "instr", "julianday",
    "length", "like", "lower", "ltrim", "max", "min", "nullif", "replace", "round", "rtrim",
    "strftime", "substr", "substring", "sum", "time", "total", "trim", "typeof", "upper",
}


def authorize_sql(action: int, first: str | None, second: str | None, database: str | None,
                  source: str | None) -> int:
    if source is not None or database not in (None, "main", "temp"):
        return sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_FUNCTION:
        return sqlite3.SQLITE_OK if second in SQL_FUNCTIONS else sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK if action in SQL_ACTIONS else sqlite3.SQLITE_DENY


def sql_statements(source: str) -> list[str]:
    statements = []
    start = 0
    for index, char in enumerate(source):
        if char == ";" and sqlite3.complete_statement(source[start:index + 1]):
            statements.append(source[start:index + 1])
            start = index + 1
            if len(statements) > 24:
                raise SnippetError("Use at most 24 SQL statements.")
    if source[start:].strip():
        if len(statements) == 24:
            raise SnippetError("Use at most 24 SQL statements.")
        statements.append(source[start:])
    return statements


def run_sql(source: str, output: Output) -> None:
    db = sqlite3.connect(":memory:")
    try:
        db.execute("PRAGMA temp_store=MEMORY")
        db.execute("PRAGMA trusted_schema=OFF")
        db.execute("PRAGMA hard_heap_limit=33554432")
        if hasattr(db, "setlimit"):
            db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 256_000)
            db.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, MAX_SOURCE)
            db.setlimit(sqlite3.SQLITE_LIMIT_COLUMN, 64)
            db.setlimit(sqlite3.SQLITE_LIMIT_COMPOUND_SELECT, 64)
        db.set_authorizer(authorize_sql)
        deadline = time.monotonic() + 1
        db.set_progress_handler(lambda: int(time.monotonic() > deadline), 500)
        for statement in sql_statements(source):
            cursor = db.execute(statement)
            if cursor.description is None:
                continue
            if output.stream.tell():
                output.write("\n")
            output.print(*(col[0] for col in cursor.description), sep="\t")
            for index, row in enumerate(cursor):
                if index == 100:
                    output.write("Showing the first 100 rows.\n")
                    break
                output.print(*(str(cell).replace("\t", " ").replace("\n", "\\n") if cell is not None
                               else "NULL" for cell in row), sep="\t")
    finally:
        db.close()


def worker_limits() -> None:
    if resource is None:
        return
    resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    try:
        resource.setrlimit(resource.RLIMIT_AS, (128 * 1024 * 1024,) * 2)
    except (OSError, ValueError):
        # macOS can reject this additional limit. Source, CPU, and output limits still apply.
        pass


def worker() -> None:
    worker_limits()
    data = json.loads(sys.stdin.buffer.read(MAX_SOURCE * 6 + 128))
    output = Output()
    error = ""
    try:
        if data["language"] == "python":
            run_python(data["source"], output)
        else:
            run_sql(data["source"], output)
    except SyntaxError as exc:
        error = f"Line {exc.lineno or 1}: {exc.msg}"
    except (SnippetError, sqlite3.Error, ArithmeticError, LookupError, TypeError, NameError,
            ValueError, RecursionError, MemoryError) as exc:
        error = str(exc) or "Resource limit reached."
    print(json.dumps(output.result(error[:500]), ensure_ascii=True))


def check_input(language: Any, source: Any) -> None:
    if not isinstance(language, str) or not isinstance(source, str) or language not in LANGUAGES:
        raise SnippetError("Run supports Python snippets and SQLite SQL.")
    try:
        length = len(source.encode("utf-8"))
    except UnicodeError as exc:
        raise SnippetError("The snippet contains invalid text.") from exc
    if not length or not source.strip() or length > MAX_SOURCE:
        raise SnippetError("Enter a snippet between 1 byte and 16 KiB.")
    if language == "python" and resource is None:
        raise SnippetError("Python Run requires the local macOS or Linux runner.")


SQL_PREFIX = re.compile(r"(?:(?:\s+)|(?:--[^\n]*(?:\n|$))|(?:/\*[\s\S]*?\*/))*")
TABLE_DEFINITION = re.compile(r"CREATE\s+TABLE\b", re.I)


def schema_authorizer(action: int, first: str | None, second: str | None, database: str | None,
                      origin: str | None) -> int:
    if action == sqlite3.SQLITE_SELECT:
        return sqlite3.SQLITE_DENY
    return authorize_sql(action, first, second, database, origin)


def check_sql(source: str) -> None:
    db = sqlite3.connect(":memory:")
    try:
        db.execute("PRAGMA trusted_schema=OFF")
        db.set_authorizer(authorize_sql)
        found = False
        for original in sql_statements(source):
            statement = original[SQL_PREFIX.match(original).end():]
            if not statement.strip(" ;\n\t\r"):
                continue
            found = True
            prefix = "" if re.match(r"EXPLAIN\b", statement, re.I) else "EXPLAIN "
            db.execute(prefix + statement).close()
            if TABLE_DEFINITION.match(statement):
                # Make table definitions available to the next statement. Deny reads
                # and SELECT during this temporary schema-only operation.
                db.set_authorizer(schema_authorizer)
                try:
                    db.execute(statement).close()
                finally:
                    db.set_authorizer(authorize_sql)
        if not found:
            raise SnippetError("Enter a SQL statement.")
    finally:
        db.close()


def inspect_snippet(language: Any, source: Any) -> dict[str, Any]:
    if os.environ.get("MEMORY_MAP_ANDROID") == "1":
        return {"runnable": False, "reason": "The isolated code runner is not available on Android."}
    try:
        check_input(language, source)
        if language == "python":
            compile(check_python(source), "<snippet>", "exec")
        else:
            check_sql(source)
    except (SnippetError, SyntaxError, sqlite3.Error, RecursionError, MemoryError, ValueError) as error:
        return {"runnable": False, "reason": str(error)[:240]}
    return {"runnable": True}


def worker_command() -> tuple[list[str], dict[str, str]]:
    environment = {"PATH": os.defpath, "LC_ALL": "C"}
    if os.name == "nt":
        environment.update({name: os.environ[name] for name in ("SystemRoot", "WINDIR") if name in os.environ})
    if getattr(sys, "frozen", False):
        environment.update({name: value for name, value in os.environ.items() if name.startswith("_PYI_")})
        return [sys.executable, "--snippet-worker"], environment
    return [sys.executable, "-I", "-S", str(Path(__file__).resolve()), "--worker"], environment


def run_snippet(language: Any, source: Any) -> dict[str, Any]:
    if os.environ.get("MEMORY_MAP_ANDROID") == "1":
        raise SnippetError("The isolated code runner is not available on Android.")
    check_input(language, source)
    if not WORKERS.acquire(blocking=False):
        raise SnippetError("The runner is busy. Try again in a moment.")
    try:
        command, environment = worker_command()
        with tempfile.TemporaryDirectory(prefix="xotira-snippet-") as directory:
            process = subprocess.run(
                command,
                input=json.dumps({"language": language, "source": source}).encode("utf-8"),
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=directory,
                env=environment, timeout=TIMEOUT_SECONDS,
            )
        if process.returncode != 0:
            return {"output": "", "error": "The snippet stopped at a resource limit.", "truncated": False}
        return json.loads(process.stdout)
    except subprocess.TimeoutExpired:
        return {"output": "", "error": "The snippet exceeded the time limit.", "truncated": False}
    finally:
        WORKERS.release()


if __name__ == "__main__" and sys.argv[1:] == ["--worker"]:
    worker()
