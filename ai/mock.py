"""Deterministic offline provider for developer-mode exercises."""

from __future__ import annotations

import json
import re
from threading import Event
from typing import Iterator

from .provider import AIEvent, AIMessage, AIProvider, CloudAPIProvider, LocalModelProvider, NotConnectedProvider, ProviderConfig, ToolCall, ToolSpec

FAILURES = {
    "[mock:error-timeout]": "timeout",
    "[mock:error-rate-limit]": "rate_limited",
    "[mock:error-cancelled]": "cancelled",
}


class MockProvider:
    name = "mock"

    def __init__(self, delay: float = 0.045) -> None:
        self.delay = delay

    def is_configured(self) -> bool:
        return True

    def test_connection(self) -> bool:
        return True

    def stream(self, messages: list[AIMessage], tools: list[ToolSpec], *, cancel_token: Event,
               max_output_tokens: int) -> Iterator[AIEvent]:
        direct = next(message.content for message in messages if message.role == "user" and not message.untrusted)
        request = json.loads(direct)
        prompt = request["prompt"]
        action = request["action"]
        language = request["language"]
        if failure := FAILURES.get(prompt):
            yield AIEvent("error", error_code=failure)
            return
        if prompt == "[mock:malformed-tool-call]":
            yield AIEvent("tool_call", tool_call=ToolCall("invalid", "update_note", {"note_id": []}))
            return
        context = next((json.loads(message.content) for message in messages if message.untrusted), {})
        current = next((note for note in context.get("notes", []) if note["kind"] == "current"), {})
        calls = []
        if action == "wizard":
            for title, body in (
                ("IELTS goals", "# Goals\n\n- [ ] Set a target band and a deadline."),
                ("IELTS study log", "# Study log\n\n| Date | Skill | Practice | Score |\n| --- | --- | --- | --- |"),
                ("IELTS review", "# Weekly review\n\n- [ ] Review mistakes and plan the next practice."),
            ):
                calls.append(("create_note", {"title": title, "body": body}))
        if prompt == "[mock:propose-edit]" and current:
            calls.append(("append_to_note", {"note_id": current["id"], "text": "Mock review: add a next step."}))
        if action in {"rewrite", "summarize", "translate", "grammar", "shorter"} and current and context.get("selection"):
            sample = {"rewrite": "Rewritten example.", "summarize": "Summary example.", "translate": "Tarjima namunasi.",
                      "grammar": "Corrected example.", "shorter": "Short example."}[action]
            calls.append(("replace_selection", {"note_id": current["id"], "text": sample}))
        if prompt == "[mock:read-current]" and current:
            calls.append(("read_note", {"note_id": current["id"]}))
        response = {
            "uz": "**Sinov javobi.** Bu javob faqat qurilmangizda ishlab chiqildi.",
            "ru": "**Тестовый ответ.** Сформирован локально на вашем устройстве.",
        }.get(language, "**Mock response.** This response was generated on your device.")
        words = re.findall(r"\S+\s*", response)
        for word in words[:max_output_tokens]:
            if cancel_token.wait(self.delay):
                yield AIEvent("error", error_code="cancelled")
                return
            yield AIEvent("text_delta", text=word)
        for number, (name, arguments) in enumerate(calls):
            if cancel_token.is_set():
                yield AIEvent("error", error_code="cancelled")
                return
            yield AIEvent("tool_call", tool_call=ToolCall(f"mock-{number}", name, arguments))
        yield AIEvent("done", usage={"output_tokens": min(len(words), max_output_tokens)})


def active_provider(name: str, *, enabled: bool, developer: bool, config: ProviderConfig | None = None) -> AIProvider:
    if not enabled:
        return NotConnectedProvider()
    if name == "mock" and developer:
        return MockProvider()
    if name == "local_model":
        return LocalModelProvider(config or ProviderConfig(name))
    if name in {"cloud_api", "openai", "anthropic", "gemini", "xai", "groq", "qwen", "deepseek", "mistral"}:
        return CloudAPIProvider(config or ProviderConfig(name))
    return NotConnectedProvider()
