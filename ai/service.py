"""Provider orchestration and expiring, single-use local previews."""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from queue import Empty, Full, Queue
from threading import BoundedSemaphore, Event, RLock, Thread
from typing import Any, Iterator
from uuid import uuid4

import settings
from vault import Vault, VaultError

from . import proposals
from .context import Context, allowed, build_context, hidden_notes
from .mock import active_provider
from .provider import AIMessage, AIProvider, ProviderConfig
from .tools import TOOLS, dispatch

CONFIG = "ai_settings"
USAGE = "ai_usage"
DEFAULTS = {"enabled": False, "provider": "none", "model": "", "baseUrl": "",
            "requestCap": 24000, "monthlyCap": 50000, "linkedDefault": False, "shareCounts": False}
PROVIDERS = {"none", "mock", "cloud_api", "local_model", "openai", "anthropic", "gemini",
             "xai", "groq", "qwen", "deepseek", "mistral"}
PREVIEW_LIFETIME = 300
MAX_OUTPUT = 400
TIMEOUT = 25
PROVIDER_SLOTS = BoundedSemaphore(2)
PUBLIC_ERRORS = {"timeout", "rate_limited", "cancelled", "not_connected"}


@dataclass
class Preview:
    context: Context
    config: dict[str, Any]
    provider: AIProvider
    session: Any
    chars: int
    estimated_tokens: int
    reserved: int
    tool_names: tuple[str, ...]
    expires: float


class AIService:
    def __init__(self, vault: Vault, mutex: RLock, *, developer: bool = False) -> None:
        self.vault = vault
        self.mutex = mutex
        self.developer = developer
        self.previews: dict[str, Preview] = {}
        self.runs: dict[str, Event] = {}

    def config(self) -> dict[str, Any]:
        return {**DEFAULTS, **settings.load(self.vault, CONFIG, {})}

    def provider(self, config: dict[str, Any]) -> AIProvider:
        import ai_providers

        def credential() -> str | None:
            with self.mutex:
                return ai_providers.read(self.vault).get(config["provider"], {}).get("key")

        options = ProviderConfig(config["provider"], config["model"], config["baseUrl"], credential)
        return active_provider(options.name, enabled=config["enabled"], developer=self.developer, config=options)

    def test_connection(self, name: Any) -> bool:
        if not isinstance(name, str) or name not in PROVIDERS:
            raise VaultError("Choose a supported AI provider.")
        return self.provider({**self.config(), "provider": name, "enabled": True}).test_connection()

    def status(self) -> dict[str, Any]:
        config = self.config()
        active = self.provider(config)
        if not self.developer and config["provider"] == "mock":
            config = {**config, "provider": "none", "enabled": False}
        return {"settings": config, "developerMode": self.developer, "connected": active.is_configured(),
                "usage": self.usage()}

    def usage(self) -> dict[str, Any]:
        return proposals.usage(self.vault)

    def reset(self) -> None:
        self.previews.clear()
        for cancel in self.runs.values():
            cancel.set()

    def save_config(self, data: dict[str, Any]) -> dict[str, Any]:
        from urllib.parse import urlsplit

        if set(data) - DEFAULTS.keys():
            raise VaultError("Invalid AI settings.")
        config = {**self.config(), **data}
        name = config["provider"]
        if not isinstance(name, str) or name not in PROVIDERS or (name == "mock" and not self.developer):
            raise VaultError("This AI provider is unavailable.")
        if any(type(config[key]) is not bool for key in ("enabled", "linkedDefault", "shareCounts")):
            raise VaultError("Invalid AI switch.")
        if (type(config["requestCap"]) is not int or not 3000 <= config["requestCap"] <= 64000
                or type(config["monthlyCap"]) is not int or not 500 <= config["monthlyCap"] <= 50_000_000):
            raise VaultError("Choose valid AI request and monthly limits.")
        if not isinstance(config["model"], str) or len(config["model"]) > 120 or not isinstance(config["baseUrl"], str) or len(config["baseUrl"]) > 240:
            raise VaultError("Invalid provider settings.")
        if config["baseUrl"]:
            parts = urlsplit(config["baseUrl"])
            if (parts.scheme != "https" and not (parts.scheme == "http" and name == "local_model"
                                                and parts.hostname in ("127.0.0.1", "::1", "localhost"))) or (
                not parts.hostname or parts.username is not None or parts.password is not None or parts.query or parts.fragment
            ):
                raise VaultError("Enter a valid provider base URL without credentials, query, or fragment.")
        settings.save(self.vault, CONFIG, config)
        self.reset()
        return self.status()

    def prepare(self, body: dict[str, Any]) -> dict[str, Any]:
        config = self.config()
        provider = self.provider(config)
        if not provider.is_configured():
            return {"errorCode": "not_connected"}
        if set(body) - {"action", "prompt", "noteId", "selection", "includeLinked", "search", "language"}:
            raise VaultError("Invalid AI request.")
        names = tuple(TOOLS)
        if body.get("action") == "wizard":
            names = ("create_note",)
        elif body.get("selection") and body.get("action") != "chat":
            names = ("replace_selection",)
        tools = [asdict(TOOLS[name]) for name in names]

        def wire_json(messages: list[dict[str, Any]]) -> str:
            envelope = {"messages": messages, "tools": tools, "max_output_tokens": MAX_OUTPUT}
            return json.dumps(envelope, ensure_ascii=False, separators=(",", ":"))

        empty = [asdict(AIMessage(role, "", untrusted=untrusted))
                 for role, untrusted in (("system", False), ("user", False), ("user", True))]
        context = build_context(self.vault, body, config["requestCap"] - len(wire_json(empty)))
        wire = wire_json([asdict(message) for message in context.messages])
        chars = len(wire)
        if chars > config["requestCap"]:
            raise VaultError("The preview exceeds its character cap. Shorten the request.", 413)
        estimated = (len(wire.encode("utf-8")) + 2) // 3
        reserved = estimated + MAX_OUTPUT
        if self.usage()["tokens"] + reserved > config["monthlyCap"]:
            return {"errorCode": "monthly_limit"}
        now = time.monotonic()
        self.previews = {key: item for key, item in self.previews.items()
                         if item.expires >= now and item.session is self.vault.cipher}
        if len(self.previews) >= 8:
            del self.previews[next(iter(self.previews))]
        identity = uuid4().hex
        self.previews[identity] = Preview(context, config, provider, self.vault.cipher,
                                          chars, estimated, reserved, names, now + PREVIEW_LIFETIME)
        return {"previewId": identity, "provider": provider.name, "chars": chars,
                "estimatedTokens": estimated, "cuts": context.cuts, "payload": wire}

    def begin(self, body: dict[str, Any]) -> tuple[str, Preview, Event]:
        identity = body.get("previewId")
        if set(body) != {"previewId"} or not isinstance(identity, str):
            raise VaultError("Review the exact request before sending it.")
        preview = self.previews.pop(identity, None)
        if (preview is None or preview.session is not self.vault.cipher or time.monotonic() > preview.expires
                or preview.config != self.config()):
            raise VaultError("Preview expired. Generate a fresh preview before sending.", 409)
        hidden = hidden_notes(self.vault)
        for note_id, revision in preview.context.revisions.items():
            if allowed(self.vault, note_id, hidden).revision != revision:
                raise VaultError("A previewed note changed. Preview the request again.", 409)
        usage = self.usage()
        if usage["tokens"] + preview.reserved > preview.config["monthlyCap"]:
            raise VaultError("The monthly AI allowance has been reached.", 429)
        if len(self.runs) >= 2:
            raise VaultError("AI is busy. Try again after a request finishes.", 429)
        settings.save(self.vault, USAGE, {**usage, "tokens": usage["tokens"] + preview.reserved,
                                        "requests": usage["requests"] + 1})
        event = Event()
        self.runs[identity] = event
        return identity, preview, event

    def provider_events(self, preview: Preview, cancel: Event, deadline: float):
        from .provider import AIEvent

        if not PROVIDER_SLOTS.acquire(blocking=False):
            yield AIEvent("error", error_code="rate_limited")
            return
        events: Queue = Queue(maxsize=16)
        finished = Event()

        def put(event) -> None:
            while not finished.is_set() and not cancel.is_set():
                try:
                    events.put(event, timeout=0.05)
                    return
                except Full:
                    continue

        def produce() -> None:
            try:
                for event in preview.provider.stream(preview.context.messages, [TOOLS[name] for name in preview.tool_names],
                                                     cancel_token=cancel, max_output_tokens=MAX_OUTPUT):
                    if finished.is_set() or cancel.is_set():
                        break
                    put(event)
            except Exception:
                put(AIEvent("error", error_code="provider_error"))
            finally:
                PROVIDER_SLOTS.release()
                put(None)

        Thread(target=produce, daemon=True).start()
        try:
            while not cancel.is_set():
                if time.monotonic() >= deadline:
                    yield AIEvent("error", error_code="timeout")
                    return
                try:
                    event = events.get(timeout=0.05)
                except Empty:
                    continue
                if event is None:
                    return
                yield event
        finally:
            finished.set()

    def stream(self, identity: str, preview: Preview, cancel: Event) -> Iterator[dict[str, Any]]:
        start = time.monotonic()
        used_output = 0
        accepted_tools = 0
        done = "cancelled"
        emitted = False
        try:
            yield {"type": "started", "requestId": identity}
            for attempt in range(3):
                for event in self.provider_events(preview, cancel, start + TIMEOUT):
                    if cancel.is_set() or self.vault.cipher is not preview.session:
                        done = "cancelled"
                        return
                    if time.monotonic() - start > TIMEOUT:
                        done = "timeout"
                        yield {"type": "error", "code": done}
                        return
                    if event.type == "error":
                        done = event.error_code if event.error_code in PUBLIC_ERRORS else "provider_error"
                        if done in ("timeout", "rate_limited") and not emitted and attempt < 2:
                            cancel.wait(0.12 * 2 ** attempt)
                            break
                        yield {"type": "error", "code": done}
                        return
                    if event.type == "text_delta" and isinstance(event.text, str):
                        used_output += len(event.text.encode("utf-8"))
                        if used_output > MAX_OUTPUT * 12:
                            done = "output_limit"
                            yield {"type": "error", "code": done}
                            return
                        emitted = True
                        yield {"type": "text_delta", "text": event.text}
                    elif event.type == "tool_call":
                        call = event.tool_call
                        emitted = True
                        accepted_tools += 1
                        if not call or not isinstance(call.name, str) or call.name not in preview.tool_names or accepted_tools > 12:
                            done = "invalid_tool"
                            yield {"type": "error", "code": done}
                            return
                        try:
                            with self.mutex:
                                self.vault.require_unlocked(touch=False)
                                if cancel.is_set() or self.vault.cipher is not preview.session:
                                    return
                                spec, result = dispatch(self.vault, preview.context, call)
                                if spec.risk == "write":
                                    item = proposals.add(self.vault, spec.name, preview.provider.name, result, time.time())
                                    output = {"type": "proposal", "proposal": item}
                                else:
                                    output = {"type": "tool_result", "tool": spec.name, "result": result}
                                proposals.audit(self.vault, preview.provider.name, "tool", tool=spec.name)
                        except VaultError:
                            done = "invalid_tool"
                            yield {"type": "error", "code": done}
                            return
                        yield output
                    elif event.type == "done":
                        done = "done"
                        reported = event.usage.get("output_tokens", 0)
                        used_output = min(MAX_OUTPUT, reported) if type(reported) is int and reported >= 0 else 0
                        yield {"type": "done", "usage": {"estimatedInputTokens": preview.estimated_tokens,
                                                         "outputTokens": used_output}}
                        return
                else:
                    if not cancel.is_set():
                        done = "provider_error"
                        yield {"type": "error", "code": done}
                    return
                if cancel.is_set():
                    return
        finally:
            cancel.set()
            with self.mutex:
                self.runs.pop(identity, None)
                if self.vault.cipher is preview.session:
                    proposals.audit(self.vault, preview.provider.name, done, input_tokens=preview.estimated_tokens,
                                    output_tokens=min(used_output, MAX_OUTPUT))

    def stop(self, identity: Any) -> None:
        if not isinstance(identity, str):
            raise VaultError("Invalid AI request.")
        if cancel := self.runs.get(identity):
            cancel.set()
