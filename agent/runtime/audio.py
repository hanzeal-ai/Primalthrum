from __future__ import annotations

from dataclasses import dataclass, field

import httpx

from .config import ModelProviderConfig
from .endpoint_policy import secure_provider_base_url
from .llm import ProviderRequestError


@dataclass(frozen=True)
class SpeechAudio:
    data: bytes
    mime_type: str


@dataclass
class OpenAISpeechProvider:
    config: ModelProviderConfig
    transport: httpx.BaseTransport | None = field(default=None, repr=False)

    @property
    def name(self) -> str:
        return self.config.provider

    @property
    def model(self) -> str:
        return self.config.model

    def __post_init__(self) -> None:
        if not self.config.api_key:
            raise ValueError(f"api_key is required for {self.name}")

    def transcribe(self, audio: bytes, filename: str, mime_type: str) -> str:
        response = self._request(
            "/audio/transcriptions",
            files={"file": (filename, audio, mime_type)},
            data={"model": self.model, "response_format": "json"},
        )
        try:
            text = str(response.json()["text"]).strip()
        except (KeyError, TypeError, ValueError) as error:
            raise ProviderRequestError("speech provider returned an invalid transcript") from error
        if not text:
            raise ProviderRequestError("speech provider returned an empty transcript")
        return text

    def synthesize(
        self,
        text: str,
        voice: str = "alloy",
        response_format: str = "mp3",
    ) -> SpeechAudio:
        response = self._request(
            "/audio/speech",
            json={
                "model": self.model,
                "input": text,
                "voice": voice,
                "response_format": response_format,
            },
        )
        if not response.content:
            raise ProviderRequestError("speech provider returned empty audio")
        return SpeechAudio(
            data=response.content,
            mime_type=_audio_mime_type(response_format),
        )

    def _request(self, path: str, **kwargs: object) -> httpx.Response:
        base_url = secure_provider_base_url(
            self.config.base_url or "https://api.openai.com/v1",
            resolve_dns=self.transport is None,
        )
        try:
            with httpx.Client(
                timeout=httpx.Timeout(90.0, connect=10.0),
                transport=self.transport,
                follow_redirects=False,
                trust_env=False,
            ) as client:
                response = client.post(
                    f"{base_url.rstrip('/')}{path}",
                    headers={"Authorization": f"Bearer {self.config.api_key}"},
                    **kwargs,
                )
                response.raise_for_status()
                return response
        except httpx.HTTPStatusError as error:
            raise ProviderRequestError(
                f"{self.name} returned HTTP {error.response.status_code}"
            ) from error
        except httpx.HTTPError as error:
            raise ProviderRequestError(f"{self.name} speech request failed") from error


def create_speech_provider(config: ModelProviderConfig) -> OpenAISpeechProvider:
    if config.provider in {"openai", "openai-compatible"}:
        return OpenAISpeechProvider(config)
    raise KeyError(f"unknown speech provider '{config.provider}'")


def _audio_mime_type(response_format: str) -> str:
    return {
        "aac": "audio/aac",
        "flac": "audio/flac",
        "mp3": "audio/mpeg",
        "opus": "audio/ogg",
        "pcm": "audio/pcm",
        "wav": "audio/wav",
    }.get(response_format, "application/octet-stream")
