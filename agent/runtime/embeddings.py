from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

import httpx

from .config import ModelProviderConfig
from .endpoint_policy import secure_provider_base_url
from .llm import ProviderRequestError, mock_embedding


class EmbeddingProvider(Protocol):
    name: str
    model: str
    usage_tokens: int

    def embed(self, texts: list[str]) -> list[list[float]]:
        ...


@dataclass
class MockEmbeddingProvider:
    model: str = "mock-embedding"
    name: str = "mock"
    usage_tokens: int = field(default=0, init=False)

    def embed(self, texts: list[str]) -> list[list[float]]:
        self.usage_tokens = sum(max(1, (len(text) + 3) // 4) for text in texts)
        return [mock_embedding(text) for text in texts]


@dataclass
class OpenAIEmbeddingProvider:
    config: ModelProviderConfig
    transport: httpx.BaseTransport | None = field(default=None, repr=False)
    name: str = field(init=False)
    model: str = field(init=False)
    usage_tokens: int = field(default=0, init=False)

    def __post_init__(self) -> None:
        self.name = self.config.provider
        self.model = self.config.model
        if not self.config.api_key:
            raise ValueError(f"api_key is required for {self.name}")

    def embed(self, texts: list[str]) -> list[list[float]]:
        base_url = secure_provider_base_url(
            self.config.base_url or "https://api.openai.com/v1",
            resolve_dns=self.transport is None,
        )
        try:
            with httpx.Client(
                timeout=httpx.Timeout(60.0, connect=10.0),
                transport=self.transport,
                follow_redirects=False,
                trust_env=False,
            ) as client:
                response = client.post(
                    f"{base_url.rstrip('/')}/embeddings",
                    headers={
                        "Authorization": f"Bearer {self.config.api_key}",
                        "Content-Type": "application/json",
                    },
                    json={"model": self.model, "input": texts},
                )
                response.raise_for_status()
                payload = response.json()
                data = payload.get("data", [])
                usage = payload.get("usage", {})
                self.usage_tokens = int(
                    usage.get("prompt_tokens") or usage.get("total_tokens") or 0
                )
                ordered = sorted(data, key=lambda item: int(item.get("index", 0)))
                return [list(map(float, item["embedding"])) for item in ordered]
        except httpx.HTTPStatusError as error:
            raise ProviderRequestError(
                f"{self.name} returned HTTP {error.response.status_code}"
            ) from error
        except (httpx.HTTPError, KeyError, TypeError, ValueError) as error:
            raise ProviderRequestError(f"{self.name} embedding request failed") from error


def create_embedding_provider(config: ModelProviderConfig) -> EmbeddingProvider:
    if config.provider == "mock":
        return MockEmbeddingProvider(model=config.model)
    if config.provider in {"openai", "openai-compatible"}:
        return OpenAIEmbeddingProvider(config)
    raise KeyError(f"unknown embedding provider '{config.provider}'")
