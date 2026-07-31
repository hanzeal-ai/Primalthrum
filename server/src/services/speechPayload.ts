const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const AUDIO_TYPES = new Set([
  'audio/aac',
  'audio/flac',
  'audio/m4a',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
]);

export interface ParsedAudioPayload {
  filename: string;
  mimeType: string;
  audioBase64: string;
  sizeBytes: number;
}

export function parseAudioPayload(input: {
  filename?: unknown;
  mimeType?: unknown;
  audioBase64?: unknown;
}): ParsedAudioPayload {
  const filename = requiredText(input.filename, 'filename');
  const mimeType = requiredText(input.mimeType, 'mimeType').toLowerCase();
  const audioBase64 = requiredText(input.audioBase64, 'audioBase64');
  if (!AUDIO_TYPES.has(mimeType)) throw new Error('audio type is not supported');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(audioBase64) || audioBase64.length % 4 !== 0) {
    throw new Error('audioBase64 is invalid');
  }
  const audio = Buffer.from(audioBase64, 'base64');
  if (!audio.length) throw new Error('audio cannot be empty');
  if (audio.length > MAX_AUDIO_BYTES) throw new Error('audio cannot exceed 8 MiB');
  if (audio.toString('base64') !== audioBase64) throw new Error('audioBase64 is invalid');
  return { filename, mimeType, audioBase64, sizeBytes: audio.length };
}

export function parseSpeechText(value: unknown): string {
  const text = requiredText(value, 'text');
  if (text.length > 4_000) throw new Error('text cannot exceed 4000 characters');
  return text;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}
