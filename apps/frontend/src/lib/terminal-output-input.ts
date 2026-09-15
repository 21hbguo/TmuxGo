interface TerminalOutputInputOptions {
  getTerminal: () => any
  pushOutput: (data: string) => void
  disposeOutput: () => void
  isDesktopImeComposing: () => boolean
  isMobile: boolean
  getHostId: () => string
  getSessionName: () => string | undefined
  onRawOutput?: (raw: string) => void
  onOutput?: () => void
  controlCarryRef: { current: string }
}
type OutputPayload = { data: string; sessionName?: string | null; hostId?: string | null; resync?: boolean }
export function createTerminalOutputInput(options: TerminalOutputInputOptions) {
  let writeBuffer = ''
  let writePending = false
  let pointerSyncActive = false
  let outputSinceLastAttach = false
  const flushWriteBuffer = () => {
    const terminal = options.getTerminal()
    if (!writeBuffer || !terminal?.write) {
      writeBuffer = ''
      writePending = false
      return
    }
    const data = writeBuffer
    writeBuffer = ''
    writePending = false
    options.pushOutput(data)
  }
  const handleOutput = (event: Event | string | OutputPayload) => {
    const payload =
      typeof event === 'string'
        ? { data: event, sessionName: null, hostId: null }
        : event instanceof Event
          ? { data: String((event as CustomEvent).detail || ''), sessionName: null, hostId: null }
          : event
    if (payload.hostId && payload.hostId !== options.getHostId()) return
    const currentSessionName = options.getSessionName()
    if (payload.sessionName && payload.sessionName !== currentSessionName) return
    const raw = payload.data
    const terminal = options.getTerminal()
    if (!raw || !terminal?.write) return
    if (payload.resync) options.disposeOutput()
    options.onRawOutput?.(raw)
    outputSinceLastAttach = true
    options.controlCarryRef.current = ''
    // Hold terminal paints while desktop IME is composing so candidate window stays put.
    if (pointerSyncActive || (!options.isMobile && options.isDesktopImeComposing())) {
      if (payload.resync) writeBuffer = raw
      else writeBuffer += raw
      if (pointerSyncActive && !writePending && !options.isDesktopImeComposing()) {
        writePending = true
        requestAnimationFrame(flushWriteBuffer)
      }
      return
    }
    options.pushOutput(raw)
  }
  const armPointerSync = () => {
    pointerSyncActive = true
  }
  const disarmPointerSync = () => {
    pointerSyncActive = false
  }
  const clearPointerSync = () => {
    pointerSyncActive = false
    flushWriteBuffer()
  }
  return {
    handleOutput,
    flushWriteBuffer,
    armPointerSync,
    disarmPointerSync,
    clearPointerSync,
    isPointerSyncActive: () => pointerSyncActive,
    consumeAttachOutputFlag: () => {
      const had = outputSinceLastAttach
      outputSinceLastAttach = false
      return had
    },
  }
}
