from __future__ import annotations

import hashlib
import json
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Protocol

import httpx

from .config import ModelProviderConfig
from .endpoint_policy import secure_provider_base_url_async


MOCK_EMBEDDING_DIMENSIONS = 8
ChatMessage = dict[str, str]


@dataclass
class LLMUsage:
    input_tokens: int = 0
    output_tokens: int = 0


class LLMProvider(Protocol):
    name: str
    model: str
    usage: LLMUsage

    def stream_chat(self, messages: list[ChatMessage]) -> AsyncIterator[str]:
        ...


class ProviderRequestError(RuntimeError):
    pass


@dataclass
class MockLLMProvider:
    model: str = "mock-chat"
    name: str = "mock"
    usage: LLMUsage = field(default_factory=LLMUsage, init=False)

    def chat(self, messages: list[ChatMessage]) -> str:
        latest = messages[-1]["content"] if messages else ""
        return f"mock response: {latest}"

    async def stream_chat(self, messages: list[ChatMessage]) -> AsyncIterator[str]:
        answer = self.chat(messages)
        self.usage = LLMUsage(
            input_tokens=_estimated_tokens("".join(message.get("content", "") for message in messages)),
            output_tokens=_estimated_tokens(answer),
        )
        for match in re.finditer(r"\S+\s*", answer):
            yield match.group(0)

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [mock_embedding(text) for text in texts]


@dataclass
class OpenAIChatProvider:
    config: ModelProviderConfig
    transport: httpx.AsyncBaseTransport | None = field(default=None, repr=False)
    name: str = field(init=False)
    model: str = field(init=False)
    usage: LLMUsage = field(default_factory=LLMUsage, init=False)

    def __post_init__(self) -> None:
        self.name = self.config.provider
        self.model = self.config.model
        if not self.config.api_key:
            raise ValueError(f"api_key is required for {self.name}")

    async def stream_chat(self, messages: list[ChatMessage]) -> AsyncIterator[str]:
        self.usage = LLMUsage()
        base_url = await secure_provider_base_url_async(
            self.config.base_url or "https://api.openai.com/v1",
            resolve_dns=self.transport is None,
        )
        payload: dict[str, object] = {
            "model": self.model,
            "messages": messages,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if self.config.temperature is not None:
            payload["temperature"] = self.config.temperature
        if self.config.max_tokens is not None:
            payload["max_tokens"] = self.config.max_tokens

        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(60.0, connect=10.0),
                transport=self.transport,
                follow_redirects=False,
                trust_env=False,
            ) as client:
                async with client.stream(
                    "POST",
                    f"{base_url.rstrip('/')}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self.config.api_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                ) as response:
                    response.raise_for_status()
                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line.removeprefix("data:").strip()
                        if data == "[DONE]":
                            break
                        content, usage = openai_event(data)
                        if usage is not None:
                            self.usage = usage
                        if content:
                            yield content
        except httpx.HTTPStatusError as error:
            raise ProviderRequestError(
                f"{self.name} returned HTTP {error.response.status_code}"
            ) from error
        except httpx.HTTPError as error:
            raise ProviderRequestError(f"{self.name} request failed") from error


@dataclass
class AnthropicChatProvider:
    config: ModelProviderConfig
    transport: httpx.AsyncBaseTransport | None = field(default=None, repr=False)
    name: str = field(default="anthropic", init=False)
    model: str = field(init=False)
    usage: LLMUsage = field(default_factory=LLMUsage, init=False)

    def __post_init__(self) -> None:
        self.model = self.config.model
        if not self.config.api_key:
            raise ValueError("api_key is required for anthropic")

    async def stream_chat(self, messages: list[ChatMessage]) -> AsyncIterator[str]:
        self.usage = LLMUsage()
        base_url = await secure_provider_base_url_async(
            self.config.base_url or "https://api.anthropic.com/v1",
            resolve_dns=self.transport is None,
        )
        system = "\n\n".join(
            message["content"] for message in messages
            if message.get("role") == "system"
        )
        chat_messages = [
            message for message in messages if message.get("role") != "system"
        ]
        payload: dict[str, object] = {
            "model": self.model,
            "messages": chat_messages,
            "max_tokens": self.config.max_tokens or 1024,
            "stream": True,
        }
        if system:
            payload["system"] = system
        if self.config.temperature is not None:
            payload["temperature"] = self.config.temperature

        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(60.0, connect=10.0),
                transport=self.transport,
                follow_redirects=False,
                trust_env=False,
            ) as client:
                async with client.stream(
                    "POST",
                    f"{base_url.rstrip('/')}/messages",
                    headers={
                        "x-api-key": self.config.api_key or "",
                        "anthropic-version": "2023-06-01",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                ) as response:
                    response.raise_for_status()
                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        content, usage = anthropic_event(line.removeprefix("data:").strip())
                        if usage is not None:
                            self.usage = LLMUsage(
                                input_tokens=usage.input_tokens or self.usage.input_tokens,
                                output_tokens=usage.output_tokens or self.usage.output_tokens,
                            )
                        if content:
                            yield content
        except httpx.HTTPStatusError as error:
            raise ProviderRequestError(
                f"anthropic returned HTTP {error.response.status_code}"
            ) from error
        except httpx.HTTPError as error:
            raise ProviderRequestError("anthropic request failed") from error


def create_llm_provider(config: ModelProviderConfig) -> LLMProvider:
    if config.provider == "mock":
        return MockLLMProvider(model=config.model)
    if config.provider in {"openai", "openai-compatible"}:
        return OpenAIChatProvider(config)
    if config.provider == "anthropic":
        return AnthropicChatProvider(config)
    raise KeyError(f"unknown llm provider '{config.provider}'")


def openai_delta(data: str) -> str:
    return openai_event(data)[0]


def openai_event(data: str) -> tuple[str, LLMUsage | None]:
    try:
        payload = json.loads(data)
        usage = payload.get("usage")
        parsed_usage = None
        if isinstance(usage, dict):
            parsed_usage = LLMUsage(
                input_tokens=int(usage.get("prompt_tokens") or 0),
                output_tokens=int(usage.get("completion_tokens") or 0),
            )
        choices = payload.get("choices") or []
        content = str(choices[0]["delta"].get("content") or "") if choices else ""
        return content, parsed_usage
    except (json.JSONDecodeError, KeyError, IndexError, TypeError, ValueError):
        return "", None


def anthropic_delta(data: str) -> str:
    return anthropic_event(data)[0]


def anthropic_event(data: str) -> tuple[str, LLMUsage | None]:
    try:
        payload = json.loads(data)
        event_type = payload.get("type")
        if event_type == "message_start":
            usage = payload.get("message", {}).get("usage", {})
            return "", LLMUsage(input_tokens=int(usage.get("input_tokens") or 0))
        if event_type == "message_delta":
            usage = payload.get("usage", {})
            return "", LLMUsage(output_tokens=int(usage.get("output_tokens") or 0))
        if event_type == "content_block_delta":
            return str(payload.get("delta", {}).get("text") or ""), None
        return "", None
    except (json.JSONDecodeError, AttributeError, TypeError, ValueError):
        return "", None


def _estimated_tokens(text: str) -> int:
    return max(1, (len(text) + 3) // 4)


def mock_embedding(text: str) -> list[float]:
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    return [
        int.from_bytes(digest[index * 4 : (index + 1) * 4], "big") / 0xFFFFFFFF
        for index in range(MOCK_EMBEDDING_DIMENSIONS)
    ]
