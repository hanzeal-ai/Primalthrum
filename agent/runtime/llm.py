from __future__ import annotations

import hashlib
import json
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Protocol

import httpx

from .config import ModelProviderConfig


MOCK_EMBEDDING_DIMENSIONS = 8
ChatMessage = dict[str, str]


class LLMProvider(Protocol):
    name: str
    model: str

    def stream_chat(self, messages: list[ChatMessage]) -> AsyncIterator[str]:
        ...


class ProviderRequestError(RuntimeError):
    pass


@dataclass
class MockLLMProvider:
    model: str = "mock-chat"
    name: str = "mock"

    def chat(self, messages: list[ChatMessage]) -> str:
        latest = messages[-1]["content"] if messages else ""
        return f"mock response: {latest}"

    async def stream_chat(self, messages: list[ChatMessage]) -> AsyncIterator[str]:
        answer = self.chat(messages)
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

    def __post_init__(self) -> None:
        self.name = self.config.provider
        self.model = self.config.model
        if not self.config.api_key:
            raise ValueError(f"api_key is required for {self.name}")

    async def stream_chat(self, messages: list[ChatMessage]) -> AsyncIterator[str]:
        base_url = self.config.base_url or "https://api.openai.com/v1"
        payload: dict[str, object] = {
            "model": self.model,
            "messages": messages,
            "stream": True,
        }
        if self.config.temperature is not None:
            payload["temperature"] = self.config.temperature
        if self.config.max_tokens is not None:
            payload["max_tokens"] = self.config.max_tokens

        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(60.0, connect=10.0),
                transport=self.transport,
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
                        content = openai_delta(data)
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

    def __post_init__(self) -> None:
        self.model = self.config.model
        if not self.config.api_key:
            raise ValueError("api_key is required for anthropic")

    async def stream_chat(self, messages: list[ChatMessage]) -> AsyncIterator[str]:
        base_url = self.config.base_url or "https://api.anthropic.com/v1"
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
                        content = anthropic_delta(line.removeprefix("data:").strip())
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
    try:
        payload = json.loads(data)
        return str(payload["choices"][0]["delta"].get("content") or "")
    except (json.JSONDecodeError, KeyError, IndexError, TypeError):
        return ""


def anthropic_delta(data: str) -> str:
    try:
        payload = json.loads(data)
        if payload.get("type") != "content_block_delta":
            return ""
        delta = payload.get("delta", {})
        return str(delta.get("text") or "")
    except (json.JSONDecodeError, TypeError):
        return ""


def mock_embedding(text: str) -> list[float]:
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    return [
        int.from_bytes(digest[index * 4 : (index + 1) * 4], "big") / 0xFFFFFFFF
        for index in range(MOCK_EMBEDDING_DIMENSIONS)
    ]
