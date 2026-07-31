import asyncio
import json
import unittest

import httpx

from runtime.config import ModelProviderConfig
from runtime.embeddings import OpenAIEmbeddingProvider
from runtime.llm import AnthropicChatProvider, OpenAIChatProvider


async def collect(provider, messages: list[dict[str, str]]) -> list[str]:
    return [delta async for delta in provider.stream_chat(messages)]


class ModelProviderTest(unittest.TestCase):
    def test_openai_chat_streams_deltas_with_configured_credentials(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(
                200,
                text=(
                    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'
                    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n'
                    'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n'
                    "data: [DONE]\n\n"
                ),
                headers={"content-type": "text/event-stream"},
            )

        provider = OpenAIChatProvider(
            ModelProviderConfig(
                provider="openai-compatible",
                model="gpt-test",
                api_key="secret-key",
                base_url="https://models.example/v1",
                temperature=0.25,
                max_tokens=256,
            ),
            transport=httpx.MockTransport(handler),
        )
        deltas = asyncio.run(collect(provider, [{"role": "user", "content": "Hi"}]))

        self.assertEqual(deltas, ["Hello", " world"])
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].url.path, "/v1/chat/completions")
        self.assertEqual(requests[0].headers["authorization"], "Bearer secret-key")
        payload = json.loads(requests[0].content)
        self.assertEqual(payload["model"], "gpt-test")
        self.assertEqual(payload["temperature"], 0.25)
        self.assertTrue(payload["stream"])
        self.assertEqual(payload["stream_options"], {"include_usage": True})
        self.assertEqual(provider.usage.input_tokens, 12)
        self.assertEqual(provider.usage.output_tokens, 3)

    def test_anthropic_chat_streams_content_block_deltas(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(
                200,
                text=(
                    'event: message_start\n'
                    'data: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n'
                    'event: content_block_delta\n'
                    'data: {"type":"content_block_delta","delta":{"text":"Ready"}}\n\n'
                    'event: content_block_delta\n'
                    'data: {"type":"content_block_delta","delta":{"text":" now"}}\n\n'
                    'event: message_delta\n'
                    'data: {"type":"message_delta","usage":{"output_tokens":4}}\n\n'
                ),
                headers={"content-type": "text/event-stream"},
            )

        provider = AnthropicChatProvider(
            ModelProviderConfig(
                provider="anthropic",
                model="claude-test",
                api_key="anthropic-secret",
                base_url="https://anthropic.example/v1",
            ),
            transport=httpx.MockTransport(handler),
        )
        deltas = asyncio.run(collect(provider, [
            {"role": "system", "content": "Be concise"},
            {"role": "user", "content": "Start"},
        ]))

        self.assertEqual(deltas, ["Ready", " now"])
        self.assertEqual(requests[0].url.path, "/v1/messages")
        self.assertEqual(requests[0].headers["x-api-key"], "anthropic-secret")
        payload = json.loads(requests[0].content)
        self.assertEqual(payload["system"], "Be concise")
        self.assertEqual(payload["messages"], [{"role": "user", "content": "Start"}])
        self.assertEqual(provider.usage.input_tokens, 9)
        self.assertEqual(provider.usage.output_tokens, 4)

    def test_openai_embedding_preserves_input_order(self) -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"index": 1, "embedding": [0.3, 0.4]},
                        {"index": 0, "embedding": [0.1, 0.2]},
                    ],
                    "usage": {"prompt_tokens": 7, "total_tokens": 7},
                },
            )

        provider = OpenAIEmbeddingProvider(
            ModelProviderConfig(
                provider="openai",
                model="embedding-test",
                api_key="embedding-secret",
                base_url="https://models.example/v1",
            ),
            transport=httpx.MockTransport(handler),
        )

        self.assertEqual(provider.embed(["first", "second"]), [[0.1, 0.2], [0.3, 0.4]])
        self.assertEqual(provider.usage_tokens, 7)
        self.assertEqual(requests[0].url.path, "/v1/embeddings")
        self.assertEqual(
            json.loads(requests[0].content),
            {"model": "embedding-test", "input": ["first", "second"]},
        )


if __name__ == "__main__":
    unittest.main()
