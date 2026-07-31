import { useEffect, useRef, useState } from 'react'

import { listProviderConfigs, synthesizeSpeech } from '../api/client'

export function useSpeechPlayback() {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef('')
  const mountedRef = useRef(true)
  const [providerConfigId, setProviderConfigId] = useState<number | undefined>()
  const [activeId, setActiveId] = useState('')
  const [error, setError] = useState('')
  const browserAvailable = typeof window.speechSynthesis !== 'undefined'

  useEffect(() => {
    mountedRef.current = true
    let active = true
    void listProviderConfigs()
      .then((providers) => {
        if (active) setProviderConfigId(providers.find((provider) => provider.type === 'tts')?.id)
      })
      .catch(() => undefined)
    return () => {
      active = false
      mountedRef.current = false
      audioRef.current?.pause()
      window.speechSynthesis?.cancel()
      stopAudio()
    }
  }, [])

  async function play(id: string, text: string) {
    stop()
    setError('')
    setActiveId(id)
    try {
      if (providerConfigId) {
        const speech = await synthesizeSpeech(text, providerConfigId)
        if (!mountedRef.current) return
        const bytes = base64Bytes(speech.audioBase64)
        const url = URL.createObjectURL(new Blob([bytes], { type: speech.mimeType }))
        const audio = new Audio(url)
        audioRef.current = audio
        audioUrlRef.current = url
        audio.onended = stop
        audio.onerror = () => {
          if (!mountedRef.current) return
          setError('语音播放失败。')
          stop()
        }
        await audio.play()
        return
      }
      if (!browserAvailable || typeof SpeechSynthesisUtterance === 'undefined') {
        throw new Error('speech playback is unavailable')
      }
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = navigator.language || 'zh-CN'
      utterance.onend = stop
      utterance.onerror = () => {
        if (!mountedRef.current) return
        setError('语音播放失败。')
        stop()
      }
      window.speechSynthesis.speak(utterance)
    } catch {
      if (!mountedRef.current) return
      setError('语音播放失败。')
      stop()
    }
  }

  function stop() {
    audioRef.current?.pause()
    window.speechSynthesis?.cancel()
    stopAudio()
    setActiveId('')
  }

  function stopAudio() {
    audioRef.current = null
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
    audioUrlRef.current = ''
  }

  return {
    activeId,
    available: Boolean(providerConfigId) || browserAvailable,
    error,
    play,
    stop,
  }
}

function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = window.atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}
