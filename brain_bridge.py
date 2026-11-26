#!/usr/bin/env python3
"""Zero-dependency stdio tool bridge (MCP-compatible) for Xotira 3D Brain."""

from __future__ import annotations

import json
import sys
from typing import Any

from brain_sdk import XotiraBrain

TOOLS = [
    {
        "name": "xotira_get_context",
        "description": "Retrieve GraphRAG context from the user's Xotira 3D Second Brain (matching notes + 1-hop linked neighbors).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Question, topic, or keywords to retrieve context for"},
                "max_chars": {"type": "integer", "default": 12000},
                "hops": {"type": "integer", "default": 1},
            },
            "required": ["query"],
        },
    },
    {
        "name": "xotira_search",
        "description": "Search notes and files in Xotira Brain with relevance scoring, snippets, and backlinks.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "tag": {"type": "string", "default": ""},
                "limit": {"type": "integer", "default": 8},
            },
            "required": ["query"],
        },
    },
    {
        "name": "xotira_read_note",
        "description": "Read the full Markdown content, tags, and links of a specific Xotira note by ID.",
        "inputSchema": {
            "type": "object",
            "properties": {"note_id": {"type": "string"}},
            "required": ["note_id"],
        },
    },
    {
        "name": "xotira_create_note",
        "description": "Propose a new Markdown note for the user to approve in Xotira.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "body": {"type": "string"},
                "tags": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["title", "body"],
        },
    },
    {
        "name": "xotira_append_note",
        "description": "Propose adding Markdown to an existing note for the user to approve in Xotira.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "note_id": {"type": "string"},
                "text": {"type": "string"},
            },
            "required": ["note_id", "text"],
        },
    },
    {
        "name": "xotira_brain_stats",
        "description": "Get an overview of Xotira Brain: note/file/link counts, clusters, tags, and top hub notes.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def send(msg: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def handle_tool(brain: XotiraBrain, name: str, args: dict[str, Any]) -> str:
    if name == "xotira_get_context":
        result = brain.context_pack(
            str(args.get("query", "")),
            max_chars=int(args.get("max_chars", 12000)),
            hops=int(args.get("hops", 1)),
        )
        return json.dumps(result, ensure_ascii=False)
    if name == "xotira_search":
        res = brain.search(str(args.get("query", "")), tag=str(args.get("tag", "")), limit=int(args.get("limit", 8)))
        return json.dumps(res, ensure_ascii=False, indent=2)
    if name == "xotira_read_note":
        return json.dumps(brain.read_note(str(args["note_id"])), ensure_ascii=False, indent=2)
    if name == "xotira_create_note":
        res = brain.save_note(str(args["title"]), str(args.get("body", "")), list(args.get("tags", [])))
        return json.dumps(res, ensure_ascii=False, indent=2)
    if name == "xotira_append_note":
        res = brain.append_note(str(args["note_id"]), str(args.get("text", "")))
        return json.dumps(res, ensure_ascii=False, indent=2)
    if name == "xotira_brain_stats":
        return json.dumps(brain.stats(), ensure_ascii=False, indent=2)
    raise ValueError(f"Unknown tool: {name}")


def main() -> None:
    brain = XotiraBrain()
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        req_id = req.get("id")
        method = req.get("method", "")
        params = req.get("params") or {}
        if method == "initialize":
            send({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "xotira-brain-bridge", "version": "6.0.0"},
                },
            })
        elif method == "notifications/initialized":
            continue
        elif method == "tools/list":
            send({"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}})
        elif method == "tools/call":
            try:
                output = handle_tool(brain, str(params.get("name", "")), dict(params.get("arguments") or {}))
                send({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {"content": [{"type": "text", "text": output}]},
                })
            except Exception as exc:
                send({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {"content": [{"type": "text", "text": f"Error: {exc}"}], "isError": True},
                })
        elif req_id is not None:
            send({"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": "Method not found"}})


if __name__ == "__main__":
    main()
