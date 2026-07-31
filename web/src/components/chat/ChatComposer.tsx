import { CircleStop, Loader2, Mic, Paperclip, Send, Square } from 'lucide-react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import { useRef } from 'react'

import { Button } from '../ui/button'
import { Textarea } from '../ui/textarea'
import { useSpeechInput } from '../../hooks/useSpeechInput'

interface ChatComposerProps {
  disabled?: boolean
  busy?: boolean
  placeholder: string
  value: string
  onChange: (value: string) => void
  onFiles?: (files: File[]) => void
  onStop?: () => void
  onSubmit: () => void
}

export function ChatComposer({
  disabled = false,
  busy = false,
  placeholder,
  value,
  onChange,
  onFiles,
  onStop,
  onSubmit,
}: ChatComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const speech = useSpeechInput((transcript) => {
    onChange([value.trim(), transcript].filter(Boolean).join(' '))
  })

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (value.trim()) onSubmit()
    }
  }

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    if (files.length) onFiles?.(files)
    event.target.value = ''
  }

  return (
    <div className="chat-composer">
      <Textarea
        aria-label="消息"
        className="min-h-16 resize-none border-0 bg-transparent px-0 py-0 shadow-none focus-visible:ring-0"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={2}
        value={value}
      />
      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          {onFiles ? (
            <>
              <input
                accept=".txt,.md,.markdown,.json,.csv"
                className="hidden"
                multiple
                onChange={handleFiles}
                ref={fileInputRef}
                type="file"
              />
              <Button
                aria-label="上传资料"
                disabled={disabled}
                onClick={() => fileInputRef.current?.click()}
                size="icon"
                title="上传资料"
                type="button"
                variant="ghost"
              >
                <Paperclip />
              </Button>
            </>
          ) : null}
          <Button
            aria-label={speech.listening ? '停止语音输入' : '开始语音输入'}
            className={speech.listening ? 'bg-red-50 text-red-600 hover:bg-red-100' : ''}
            disabled={disabled || !speech.available || speech.processing}
            onClick={speech.listening ? speech.stop : speech.start}
            size="icon"
            title={speech.available ? '语音输入' : '当前浏览器不支持语音识别'}
            type="button"
            variant="ghost"
          >
            {speech.processing ? <Loader2 className="animate-spin" /> : speech.listening ? <Square /> : <Mic />}
          </Button>
          <span className="hidden text-xs text-zinc-500 sm:inline">
            {speech.processing ? '正在转写...' : speech.listening ? '正在聆听...' : speech.error || '支持语音与文字'}
          </span>
        </div>
        {busy && onStop ? (
          <Button
            aria-label="停止生成"
            className="bg-red-600 hover:bg-red-700"
            onClick={onStop}
            size="icon"
            title="停止生成"
            type="button"
          >
            <CircleStop />
          </Button>
        ) : (
          <Button
            aria-label="发送"
            disabled={disabled || !value.trim()}
            onClick={onSubmit}
            size="icon"
            type="button"
          >
            {busy ? <Loader2 className="animate-spin" /> : <Send />}
          </Button>
        )}
      </div>
    </div>
  )
}
