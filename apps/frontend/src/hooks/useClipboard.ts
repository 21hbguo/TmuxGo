import { useCallback, useState } from 'react'
import { readClipboardTextOnly, writeClipboardText } from '@/lib/clipboard-text'

export function useClipboard() {
  const [copied, setCopied] = useState(false)

  const copy = useCallback(async (text: string) => {
    try {
      const result = await writeClipboardText(text)
      if (!result.copied) return false
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      return true
    } catch (err) {
      console.error('Failed to copy:', err)
      return false
    }
  }, [])

  const paste = useCallback(async (): Promise<string | null> => {
    try {
      const result = await readClipboardTextOnly()
      return result.text || null
    } catch (err) {
      console.error('Failed to paste:', err)
      return null
    }
  }, [])

  return { copy, paste, copied }
}

export function copyTerminalSelection(terminal: any): string | null {
  if (!terminal) return null
  const selection = terminal.getSelection()
  if (selection) {
    void writeClipboardText(selection)
    return selection
  }
  return null
}
