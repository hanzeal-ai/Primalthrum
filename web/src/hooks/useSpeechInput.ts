import { useRef, useState } from 'react'

interface SpeechRecognitionEventLike {
  results: ArrayLike<{
    0: { transcript: string }
    isFinal: boolean
  }>
}

interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  onend: (() => void) | null
  onerror: (() => void) | null
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  start: () => void
  stop: () => void
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
}

export function useSpeechInput(onTranscript: (transcript: string) => void) {
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const [listening, setListening] = useState(false)
  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition
  const available = Boolean(Recognition)

  function start() {
    if (!Recognition || listening) return

    const recognition = new Recognition()
    recognition.continuous = false
    recognition.interimResults = true
    recognition.lang = navigator.language || 'zh-CN'
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? '')
        .join('')
        .trim()
      if (transcript) onTranscript(transcript)
    }
    recognition.onend = () => setListening(false)
    recognition.onerror = () => setListening(false)
    recognitionRef.current = recognition
    setListening(true)
    recognition.start()
  }

  function stop() {
    recognitionRef.current?.stop()
    recognitionRef.current = null
    setListening(false)
  }

  return { available, listening, start, stop }
}
