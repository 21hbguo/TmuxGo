import { useCallback, useState } from 'react'

export function useClipboard() {
  const [copied, setCopied] = useState(false)

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
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
      const text = await navigator.clipboard.readText()
      return text
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
    navigator.clipboard.writeText(selection)
    return selection
  }
  return null
}
