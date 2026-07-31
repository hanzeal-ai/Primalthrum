import { useEffect, useRef, useState } from 'react'

import { listProviderConfigs, transcribeAudio } from '../api/client'

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
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timeoutRef = useRef<number | null>(null)
  const transcriptRef = useRef(onTranscript)
  const mountedRef = useRef(true)
  const recordingStartedAtRef = useRef(0)
  const [providerConfigId, setProviderConfigId] = useState<number | undefined>()
  const [listening, setListening] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState('')
  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition
  const recorderAvailable = Boolean(navigator.mediaDevices?.getUserMedia)
    && typeof MediaRecorder !== 'undefined'
  const available = Boolean(Recognition) || recorderAvailable

  useEffect(() => {
    transcriptRef.current = onTranscript
  }, [onTranscript])

  useEffect(() => {
    mountedRef.current = true
    let active = true
    void listProviderConfigs()
      .then((providers) => {
        if (active) setProviderConfigId(providers.find((provider) => provider.type === 'stt')?.id)
      })
      .catch(() => undefined)
    return () => {
      active = false
      mountedRef.current = false
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
      const recognition = recognitionRef.current
      if (recognition) {
        recognition.onend = null
        recognition.onerror = null
        recognition.onresult = null
        recognition.stop()
      }
      const recorder = recorderRef.current
      if (recorder) {
        recorder.ondataavailable = null
        recorder.onerror = null
        recorder.onstop = null
        if (recorder.state !== 'inactive') recorder.stop()
      }
      stopMediaStream()
    }
  }, [])

  async function start() {
    if (listening || processing) return
    setError('')
    if (providerConfigId && recorderAvailable) {
      await startRecorder(providerConfigId)
      return
    }
    startBrowserRecognition()
  }

  async function startRecorder(sttProviderConfigId: number) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      const mimeType = preferredRecordingMimeType()
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)
      streamRef.current = stream
      recorderRef.current = recorder
      chunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data)
      }
      recorder.onerror = () => {
        if (!mountedRef.current) return
        setError('录音失败，请重试。')
        setListening(false)
        stopMediaStream()
      }
      recorder.onstop = () => {
        if (timeoutRef.current !== null) {
          window.clearTimeout(timeoutRef.current)
          timeoutRef.current = null
        }
        const audio = new Blob(chunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        })
        recorderRef.current = null
        stopMediaStream()
        if (!mountedRef.current) return
        setListening(false)
        if (!audio.size) {
          setError('没有录到有效音频。')
          return
        }
        setProcessing(true)
        const durationMs = Math.max(1, Math.round(performance.now() - recordingStartedAtRef.current))
        void transcribeAudio(audio, sttProviderConfigId, durationMs)
          .then((result) => {
            if (mountedRef.current) transcriptRef.current(result.text)
          })
          .catch(() => {
            if (mountedRef.current) setError('语音转写失败，请重试或改用文字输入。')
          })
          .finally(() => {
            if (mountedRef.current) setProcessing(false)
          })
      }
      recorder.start(250)
      recordingStartedAtRef.current = performance.now()
      setListening(true)
      timeoutRef.current = window.setTimeout(stop, 60_000)
    } catch {
      if (!mountedRef.current) return
      setError('无法访问麦克风，请检查浏览器权限。')
      setListening(false)
      stopMediaStream()
    }
  }

  function startBrowserRecognition() {
    if (!Recognition) {
      setError('当前浏览器不支持语音输入。')
      return
    }
    const recognition = new Recognition()
    recognition.continuous = false
    recognition.interimResults = true
    recognition.lang = navigator.language || 'zh-CN'
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? '')
        .join('')
        .trim()
      if (transcript) transcriptRef.current(transcript)
    }
    recognition.onend = () => setListening(false)
    recognition.onerror = () => {
      setError('浏览器语音识别失败，请重试。')
      setListening(false)
    }
    recognitionRef.current = recognition
    setListening(true)
    recognition.start()
  }

  function stop() {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    if (recorderRef.current?.state !== 'inactive') recorderRef.current?.stop()
    recognitionRef.current?.stop()
    recognitionRef.current = null
    setListening(false)
  }

  function stopMediaStream() {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }

  return { available, error, listening, processing, start, stop }
}

function preferredRecordingMimeType(): string {
  return [
    'audio/webm;codecs=opus',
    'audio/mp4',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ].find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? ''
}
