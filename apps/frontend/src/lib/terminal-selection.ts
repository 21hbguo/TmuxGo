export function requestTerminalSelection(timeout = 80) {
  return new Promise<string>((resolve) => {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    let settled = false
    const fallbackText = window.getSelection()?.toString() || ''
    const finish = (text: string) => {
      if (settled) return
      settled = true
      window.removeEventListener('tmuxgo-terminal-selection', handleSelection as EventListener)
      resolve(text)
    }
    const handleSelection = (event: Event) => {
      const detail = (event as CustomEvent<{ requestId?: string; selection?: string }>).detail
      if (detail?.requestId !== requestId) return
      finish(detail.selection || fallbackText)
    }
    window.addEventListener('tmuxgo-terminal-selection', handleSelection as EventListener)
    window.dispatchEvent(new CustomEvent('tmuxgo-copy-terminal-selection', { detail: { requestId } }))
    window.setTimeout(() => finish(fallbackText), timeout)
  })
}
