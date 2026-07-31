import json
import unittest

import httpx

from runtime.audio import OpenAISpeechProvider
from runtime.config import ModelProviderConfig


class AudioProviderTest(unittest.TestCase):
    def test_openai_compatible_transcription_uses_multipart_audio(self) -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, json={"text": "transcribed request"})

        provider = OpenAISpeechProvider(
            ModelProviderConfig(
                provider="openai-compatible",
                model="speech-test",
                api_key="speech-secret",
                base_url="https://speech.example/v1",
            ),
            transport=httpx.MockTransport(handler),
        )
        text = provider.transcribe(b"audio-bytes", "recording.webm", "audio/webm")

        self.assertEqual(text, "transcribed request")
        self.assertEqual(requests[0].url.path, "/v1/audio/transcriptions")
        self.assertEqual(requests[0].headers["authorization"], "Bearer speech-secret")
        self.assertIn(b'name="model"', requests[0].content)
        self.assertIn(b"speech-test", requests[0].content)
        self.assertIn(b"audio-bytes", requests[0].content)

    def test_openai_compatible_synthesis_returns_audio_metadata(self) -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, content=b"mp3-bytes")

        provider = OpenAISpeechProvider(
            ModelProviderConfig(
                provider="openai",
                model="tts-test",
                api_key="speech-secret",
                base_url="https://speech.example/v1",
            ),
            transport=httpx.MockTransport(handler),
        )
        audio = provider.synthesize("Read this", voice="alloy", response_format="mp3")

        self.assertEqual(audio.data, b"mp3-bytes")
        self.assertEqual(audio.mime_type, "audio/mpeg")
        self.assertEqual(requests[0].url.path, "/v1/audio/speech")
        self.assertEqual(
            json.loads(requests[0].content),
            {
                "model": "tts-test",
                "input": "Read this",
                "voice": "alloy",
                "response_format": "mp3",
            },
        )


if __name__ == "__main__":
    unittest.main()
