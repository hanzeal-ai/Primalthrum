import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSpeechInput } from './useSpeechInput'

const api = vi.hoisted(() => ({
  listProviderConfigs: vi.fn(),
  transcribeAudio: vi.fn(),
}))

vi.mock('../api/client', () => api)

const stopTrack = vi.fn()

class FakeMediaRecorder {
  static isTypeSupported() {
    return true
  }

  mimeType: string
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onerror: (() => void) | null = null
  onstop: (() => void) | null = null
  state: RecordingState = 'inactive'

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType ?? 'audio/webm'
  }

  start() {
    this.state = 'recording'
  }

  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) } as BlobEvent)
    this.onstop?.()
  }
}

function SpeechHarness() {
  const [transcript, setTranscript] = useState('')
  const speech = useSpeechInput(setTranscript)

  return (
    <>
      <button onClick={speech.listening ? speech.stop : speech.start} type="button">
        {speech.listening ? 'stop' : speech.processing ? 'processing' : 'start'}
      </button>
      <output>{transcript || speech.error}</output>
    </>
  )
}

describe('useSpeechInput', () => {
  beforeEach(() => {
    api.listProviderConfigs.mockResolvedValue([{
      id: 7,
      type: 'stt',
      config: { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
    }])
    api.transcribeAudio.mockResolvedValue({ text: 'voice transcript' })
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: stopTrack }],
        }),
      },
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    Reflect.deleteProperty(navigator, 'mediaDevices')
  })

  it('records with a configured STT provider and appends the transcript', async () => {
    render(<SpeechHarness />)
    await waitFor(() => expect(api.listProviderConfigs).toHaveBeenCalledOnce())

    fireEvent.click(screen.getByRole('button', { name: 'start' }))
    await screen.findByRole('button', { name: 'stop' })
    fireEvent.click(screen.getByRole('button', { name: 'stop' }))

    await waitFor(() => expect(api.transcribeAudio).toHaveBeenCalledWith(expect.any(Blob), 7))
    expect(await screen.findByText('voice transcript')).toBeTruthy()
    expect(stopTrack).toHaveBeenCalled()
  })
})
