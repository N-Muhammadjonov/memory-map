"""Provider interface and offline adapters."""

from __future__ import annotations

from dataclasses import dataclass, field
from threading import Event
from typing import Any, Callable, Iterator, Literal, Protocol


@dataclass(frozen=True)
class AIMessage:
    role: Literal["system", "user", "assistant", "tool"]
    content: str
    untrusted: bool = False


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]
    risk: Literal["read", "write"]


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: Any


@dataclass(frozen=True)
class AIEvent:
    type: str
    text: str = ""
    tool_call: ToolCall | None = None
    usage: dict[str, int] = field(default_factory=dict)
    error_code: str | None = None


@dataclass(frozen=True)
class ProviderConfig:
    name: str
    model: str = ""
    base_url: str = ""
    credential: Callable[[], str | None] = field(default=lambda: None, repr=False)


class AIProvider(Protocol):
    name: str

    def is_configured(self) -> bool: ...

    def test_connection(self) -> bool: ...

    def stream(
        self, messages: list[AIMessage], tools: list[ToolSpec], *,
        cancel_token: Event, max_output_tokens: int,
    ) -> Iterator[AIEvent]: ...


class NotConnectedProvider:
    name = "not_connected"

    def is_configured(self) -> bool:
        return False

    def test_connection(self) -> bool:
        return False

    def stream(self, messages, tools, *, cancel_token, max_output_tokens) -> Iterator[AIEvent]:
        yield AIEvent("error", error_code="not_connected")


class CloudAPIProvider(NotConnectedProvider):
    """Implement direct transport after verifying the selected provider's official contract."""

    def __init__(self, config: ProviderConfig) -> None:
        self.config = config
        self.name = config.name


class LocalModelProvider(NotConnectedProvider):
    """Implement explicit local model transport after verifying its contract."""

    def __init__(self, config: ProviderConfig) -> None:
        self.config = config
        self.name = config.name
