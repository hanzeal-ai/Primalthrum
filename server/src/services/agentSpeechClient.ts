import { type RuntimeModelEndpoint } from './runtimeProviderResolver';
import { type ParsedAudioPayload } from './speechPayload';

export interface TranscriptionResult {
  provider: string;
  model: string;
  text: string;
}

export interface SpeechSynthesisResult {
  provider: string;
  model: string;
  mimeType: string;
  audioBase64: string;
}

export class AgentSpeechClient {
  constructor(private readonly agentBaseUrl: string) {}

  transcribe(
    provider: RuntimeModelEndpoint,
    audio: ParsedAudioPayload,
  ): Promise<TranscriptionResult> {
    return this.post('/internal/speech/transcriptions', {
      provider,
      filename: audio.filename,
      mime_type: audio.mimeType,
      audio_base64: audio.audioBase64,
    });
  }

  synthesize(
    provider: RuntimeModelEndpoint,
    text: string,
    voice = 'alloy',
  ): Promise<SpeechSynthesisResult> {
    return this.post('/internal/speech/synthesis', {
      provider,
      text,
      voice,
      response_format: 'mp3',
    });
  }

  private async post<Result>(path: string, body: Record<string, unknown>): Promise<Result> {
    const response = await fetch(`${this.agentBaseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      let message = 'speech request failed';
      try {
        const payload = await response.json() as { detail?: unknown };
        if (typeof payload.detail === 'string') message = payload.detail;
      } catch {
        // Keep the stable fallback when an upstream does not return JSON.
      }
      throw new Error(`speech service returned HTTP ${response.status}: ${message}`);
    }
    return response.json() as Promise<Result>;
  }
}
