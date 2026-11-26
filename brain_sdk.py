"""Standard-library client for a local Xotira agent API."""

from __future__ import annotations

import json
import os
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req: Request, fp: Any, code: int, msg: str,
                         headers: Any, newurl: str) -> None:
        return None


class XotiraBrain:
    def __init__(self, url: str | None = None, key: str | None = None) -> None:
        self.url = (url or os.environ.get("XOTIRA_BRAIN_URL", "")).rstrip("/")
        self.key = key or os.environ.get("XOTIRA_BRAIN_KEY", "")
        self.opener = build_opener(NoRedirect())

    def _request(self, path: str, *, query: dict[str, Any] | None = None,
                 body: dict[str, Any] | None = None) -> dict[str, Any]:
        address = urlsplit(self.url)
        if (address.scheme != "http" or address.hostname != "127.0.0.1" or not address.port
                or address.username is not None or address.path or address.query or address.fragment or not self.key):
            raise ValueError("Set XOTIRA_BRAIN_URL and XOTIRA_BRAIN_KEY from the local Xotira agent panel.")
        request = Request(self.url + "/api/agent/" + path + ("?" + urlencode(query) if query else ""),
                          data=json.dumps(body).encode("utf-8") if body is not None else None,
                          headers={"X-Brain-Key": self.key, "Content-Type": "application/json"})
        try:
            with self.opener.open(request, timeout=10) as response:
                return json.load(response)
        except HTTPError as error:
            with error:
                try:
                    message = json.load(error).get("error")
                except (ValueError, OSError):
                    message = None
            raise ValueError(message or f"Xotira returned HTTP {error.code}.") from error

    def search(self, query: str, *, tag: str = "", limit: int = 8) -> dict[str, Any]:
        return self._request("search", query={"q": query, "tag": tag, "limit": limit})

    def context_pack(self, query: str, *, max_chars: int = 12000, hops: int = 1) -> dict[str, Any]:
        return self._request("context", query={"q": query, "max_chars": max_chars, "hops": hops})

    def get_context(self, query: str, *, max_chars: int = 12000, hops: int = 1) -> str:
        return self.context_pack(query, max_chars=max_chars, hops=hops)["context"]

    def read_note(self, note_id: str) -> dict[str, Any]:
        return self._request("notes/" + note_id)

    def save_note(self, title: str, body: str, tags: list[str]) -> dict[str, Any]:
        return self._request("notes", body={"title": title, "body": body, "tags": tags})

    def append_note(self, note_id: str, text: str) -> dict[str, Any]:
        return self._request("notes/" + note_id + "/append", body={"text": text})

    def stats(self) -> dict[str, Any]:
        return self._request("stats")
