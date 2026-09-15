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
const SELECTION_HOLD_MAX_BUFFER = 1024 * 1024
const SELECTION_HOLD_CHECK_MS = 800
export function createTerminalOutputInput(options: TerminalOutputInputOptions) {
  let writeBuffer = ''
  let writePending = false
  let pointerSyncActive = false
  let selectionHold = false
  let lastSelectionCheck = 0
  let outputSinceLastAttach = false
  const releaseSelection = () => {
    if (!selectionHold) return
    selectionHold = false
    flushWriteBuffer()
  }
  const flushWriteBuffer = () => {
    if (selectionHold) return
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
    if (pointerSyncActive || selectionHold || (!options.isMobile && options.isDesktopImeComposing())) {
      if (payload.resync) writeBuffer = raw
      else writeBuffer += raw
      if (selectionHold) {
        if (writeBuffer.length > SELECTION_HOLD_MAX_BUFFER) releaseSelection()
        else {
          const now = Date.now()
          if (now - lastSelectionCheck >= SELECTION_HOLD_CHECK_MS) {
            lastSelectionCheck = now
            if (!pointerSyncActive && !terminal.getSelection?.()) releaseSelection()
          }
        }
        return
      }
      if (pointerSyncActive && !writePending && !options.isDesktopImeComposing()) {
        writePending = true
        requestAnimationFrame(flushWriteBuffer)
      }
      return
    }
    options.pushOutput(raw)
  }
  const holdSelection = () => {
    selectionHold = true
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
    holdSelection,
    releaseSelection,
    isSelectionHoldActive: () => selectionHold,
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
