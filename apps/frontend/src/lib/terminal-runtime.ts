import { api } from '@/lib/api'
import { createTerminalPaneInteractions } from './terminal-pane-interactions'
import { createTerminalPaneResizeController } from './terminal-pane-resize'
import { createTerminalClipboardIme } from './terminal-clipboard-ime'
import { createTerminalCore } from './terminal-core'
import { createTerminalLayout } from './terminal-layout'
import { createTerminalResizeMask } from './terminal-resize-mask'
import { createTerminalFocus } from './terminal-focus'
import { createDeleteWordRepeat } from './terminal-key-repeat'
import { createSessionSnapshotLoader } from './terminal-snapshot'
import { createTerminalOutputInput } from './terminal-output-input'
import { createTerminalKeyEventHandler } from './terminal-key-handler'
import { createTerminalImeHandlers } from './terminal-ime-handlers'
import { collectTerminalLineLinks, openUrlInNewWindow, type TerminalLineLink } from './terminal-links'
import { chooseFileRoot, getRootRelativePath, resolveCandidateAbsolutePaths } from './terminal-paths'
import { recordMobileDebug, recordImeDebug } from './terminal-debug'
import { openFileInEditor } from './editor-open'
import type { useTranslation } from '@/i18n'
import type { FileDocumentHandle, FileRoot } from '@/types'
const SCROLLBACK_LIMIT = 600
interface TerminalRuntimeOptions {
  container: HTMLElement
  isMobile: boolean
  terminalInstance: { current: any }
  onInputRef: { current: ((data: string) => void) | undefined }
  onResizeRef: { current: ((cols: number, rows: number) => void) | undefined }
  attachExclusiveRef: { current: boolean }
  onReadyRef: { current: (() => void) | undefined }
  sessionNameRef: { current: string | undefined }
  preferencesRef: { current: any }
  resubscribeOutputRef: { current: () => void }
  lastSizeRef: { current: { cols: number; rows: number } | null }
  sharedSessionSizeRef: { current: { cols: number; rows: number } | null }
  controlCarryRef: { current: string }
  scheduleLayoutRef: { current: (delay?: number, force?: boolean, resetFont?: boolean) => void }
  activeHostIdRef: { current: string | null }
  tRef: { current: ReturnType<typeof useTranslation>['t'] }
  afterTerminalWriteRef: { current: () => void }
  subscribeOutputRef: {
    current: (
      hostId: string,
      sessionName: string,
      listener: (message: {
        data: string
        sessionName?: string | null
        hostId?: string | null
        resync?: boolean
      }) => void,
    ) => () => void
  }
  sendRef: { current: (data: any) => boolean }
  resolvePaneAtPointRef: { current: (x: number, y: number) => string | null }
  paneResizeGuide: HTMLElement | null
  resizeMaskElement: HTMLElement | null
  resizeMaskApiRef: { current: ReturnType<typeof createTerminalResizeMask> | null }
  queryClient: any
  pushToast: (toast: { type: 'success' | 'error' | 'info'; message: string; durationMs?: number }) => void
  setActivePane: (paneId: string) => void
  updateTerminalPerf: (patch: Record<string, unknown>) => void
  getTerminalPerf: () => any
  selectionSync: any
  pasteBridge: any
  dropState: any
  touchScroll: any
  pinch: {
    handleTouchStart: (event: TouchEvent) => void
    handleTouchMove: (event: TouchEvent) => void
    handleTouchEnd: (event: TouchEvent) => void
    handleTouchCancel: (event: TouchEvent) => void
    handleDesktopPinch: (event: WheelEvent) => void
  }
  syncPaneCwd: () => Promise<string>
  ensureFileRoots: () => Promise<FileRoot[]>
  ensureAppFontLoaded: (family: string, size: number) => Promise<unknown>
  focusKeyboard: () => void
  updateGithubDeviceLogin: (raw: string) => void
  pushTerminalOutput: (data: string) => void
  disposeTerminalOutput: () => void
}
export function createTerminalRuntime(options: TerminalRuntimeOptions) {
  const container = options.container
  const isMobileDevice = options.isMobile
  const terminalInstance = options.terminalInstance
  const onInputRef = options.onInputRef
  const onResizeRef = options.onResizeRef
  const attachExclusiveRef = options.attachExclusiveRef
  const onReadyRef = options.onReadyRef
  const sessionNameRef = options.sessionNameRef
  const preferencesRef = options.preferencesRef
  const resubscribeOutputRef = options.resubscribeOutputRef
  const lastSizeRef = options.lastSizeRef
  const sharedSessionSizeRef = options.sharedSessionSizeRef
  const controlCarryRef = options.controlCarryRef
  const scheduleLayoutRef = options.scheduleLayoutRef
  const activeHostIdRef = options.activeHostIdRef
  const tRef = options.tRef
  const afterTerminalWriteRef = options.afterTerminalWriteRef
  const subscribeOutputRef = options.subscribeOutputRef
  const sendRef = options.sendRef
  const pushToast = options.pushToast
  const setActivePane = options.setActivePane
  const updateTerminalPerf = options.updateTerminalPerf
  const selectionSync = options.selectionSync
  const pasteBridge = options.pasteBridge
  const dropState = options.dropState
  const touchScroll = options.touchScroll
  const pinch = options.pinch
  const focusKeyboard = options.focusKeyboard
  const updateGithubDeviceLogin = options.updateGithubDeviceLogin
  const pushTerminalOutput = options.pushTerminalOutput
  const disposeTerminalOutput = options.disposeTerminalOutput
  const queryClient = options.queryClient
  const syncPaneCwd = options.syncPaneCwd
  const ensureFileRoots = options.ensureFileRoots
  let terminal: any = null
  let resizeObserver: ResizeObserver | null = null
  const disposables: any[] = []
  let disposed = false
  let readyNotified = false
  let attachEventCount = 0
  let helperTextarea: HTMLTextAreaElement | null | undefined = null
  const getTerminal = () => terminal
  const isDisposed = () => disposed
  const notifyReady = () => {
    if (disposed || readyNotified) return
    readyNotified = true
    onReadyRef.current?.()
  }
  const requestServerRedraw = () => {
    const currentSessionName = sessionNameRef.current
    if (!currentSessionName) return
    sendRef.current({ type: 'redraw', hostId: activeHostIdRef.current || 'local', sessionName: currentSessionName })
  }
  const cancelTmuxCopyMode = () => {
    const currentSessionName = sessionNameRef.current
    if (!currentSessionName) return
    recordMobileDebug('tmux-copy-mode-cancel', { sessionName: currentSessionName })
    sendRef.current({
      type: 'copy_mode_cancel',
      hostId: activeHostIdRef.current || 'local',
      sessionName: currentSessionName,
    })
  }
  const mask = createTerminalResizeMask({ mask: options.resizeMaskElement, getTerminal })
  options.resizeMaskApiRef.current = mask
  const layout = createTerminalLayout({
    container,
    isMobile: isMobileDevice,
    getTerminal,
    isDisposed,
    preferencesRef,
    attachExclusiveRef,
    lastSizeRef,
    sharedSessionSizeRef,
    onResizeRef,
    controlCarryRef,
    mask,
    getTerminalPerf: options.getTerminalPerf,
    updateTerminalPerf,
    notifyReady,
    requestServerRedraw,
  })
  scheduleLayoutRef.current = layout.scheduleLayoutSync
  const focus = createTerminalFocus({
    container,
    isMobile: isMobileDevice,
    getTerminal,
    focusKeyboard,
    cancelTmuxCopyMode,
  })
  const deleteWordRepeat = createDeleteWordRepeat({ send: (data) => onInputRef.current?.(data), isDisposed })
  const snapshotLoader = createSessionSnapshotLoader({
    queryClient,
    getSnapshot: (hostId, name) => api.snapshot.get(hostId, name),
    hostIdRef: activeHostIdRef,
    sessionNameRef,
  })
  const { getSelectionText, getMouseCell, getPaneIdByMouseCell, getPaneResizeTarget, getPaneIdAtPoint } =
    createTerminalPaneInteractions(getTerminal, container, snapshotLoader.read)
  options.resolvePaneAtPointRef.current = getPaneIdAtPoint
  const outputInput = createTerminalOutputInput({
    getTerminal,
    pushOutput: pushTerminalOutput,
    disposeOutput: disposeTerminalOutput,
    isDesktopImeComposing: focus.isDesktopImeComposing,
    isMobile: isMobileDevice,
    getHostId: () => activeHostIdRef.current || 'local',
    getSessionName: () => sessionNameRef.current,
    onRawOutput: updateGithubDeviceLogin,
    controlCarryRef,
  })
  const imeHandlers = createTerminalImeHandlers({
    getHelperTextarea: () => helperTextarea,
    isComposing: focus.isComposing,
    setComposing: focus.setComposing,
    flushWriteBuffer: outputInput.flushWriteBuffer,
    syncHelperTextareaGeometry: focus.syncHelperTextareaGeometry,
  })
  const isLinkOpenGesture = (event: MouseEvent) =>
    event.button === 0 && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && !isMobileDevice
  const resolveTerminalFileLink = async (link: Extract<TerminalLineLink, { kind: 'file' }>) => {
    const cwd = await syncPaneCwd()
    const roots = await ensureFileRoots()
    const hostId = activeHostIdRef.current || 'local'
    const absolutePaths = resolveCandidateAbsolutePaths(link.pathText, cwd, roots)
    for (const absolutePath of absolutePaths) {
      const root = chooseFileRoot(roots, absolutePath)
      if (!root) continue
      const relativePath = getRootRelativePath(root.path, absolutePath)
      if (relativePath == null) continue
      try {
        const preview = await api.files.preview(hostId, root.id, relativePath, link.line || 1)
        if (preview.type !== 'file') continue
        const name = relativePath.split('/').filter(Boolean).pop() || absolutePath.split('/').pop() || absolutePath
        return {
          file: {
            id: `${hostId}:${root.id}:${relativePath}`,
            hostId,
            rootId: root.id,
            rootLabel: root.label,
            rootPath: root.path,
            path: relativePath,
            name,
            absolutePath,
            type: 'file',
          } satisfies FileDocumentHandle,
          position: { line: link.line, column: link.column },
        }
      } catch {}
    }
    return null
  }
  const getBufferLineText = (lineIndex: number) => {
    const line = terminal?.buffer?.active?.getLine?.(lineIndex)
    if (!line) return ''
    try {
      return String(line.translateToString(true))
    } catch {
      return ''
    }
  }
  const createTerminalFileLinks = (bufferLineNumber: number) => {
    const line = getBufferLineText(bufferLineNumber - 1)
    return collectTerminalLineLinks(line)
      .filter((item): item is Extract<TerminalLineLink, { kind: 'file' }> => item.kind === 'file')
      .map((item) => ({
        range: { start: { x: item.start + 1, y: bufferLineNumber }, end: { x: item.end, y: bufferLineNumber } },
        text: item.text,
        decorations: { pointerCursor: true, underline: true },
        activate: (event: MouseEvent) => {
          if (!isLinkOpenGesture(event)) return
          event.preventDefault()
          event.stopPropagation()
          event.stopImmediatePropagation?.()
          void resolveTerminalFileLink(item).then((result) => {
            if (!result?.file) return
            return openFileInEditor(result.file, {
              t: tRef.current,
              pushToast,
              position: result.position,
              openPanel: true,
            })
          })
        },
      }))
  }
  const paneResize = createTerminalPaneResizeController({
    container,
    guide: options.paneResizeGuide,
    getTerminal,
    getMouseCell,
    getPaneResizeTarget,
    resizePane: (paneId, size) => api.panes.resize(paneId, size),
    loadSessionSnapshot: () => snapshotLoader.load(true),
    showResizeMask: mask.show,
    revealResizeMask: mask.reveal,
    clearSelection: () => terminal?.clearSelection?.(),
    clearCopySelectionTimer: selectionSync.clearCopySelectionTimer,
    clearPointerSync: outputInput.disarmPointerSync,
    dispatchLayoutChange: () =>
      window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'tmux-pane-resize' } })),
  })
  const syncActivePane = async () => {
    const hostId = activeHostIdRef.current
    const currentSessionName = sessionNameRef.current
    if (!hostId || !currentSessionName) return
    try {
      const snapshot = await snapshotLoader.load(true)
      if (snapshot?.activePaneId) setActivePane(snapshot.activePaneId)
    } catch {}
  }
  const initTerminal = async () => {
    if (disposed) return
    const core = await createTerminalCore({
      container,
      preferences: preferencesRef.current,
      isMobile: isMobileDevice,
      scrollback: SCROLLBACK_LIMIT,
      ensureAppFontLoaded: options.ensureAppFontLoaded,
      isLinkOpenGesture,
      openUrl: (url) => openUrlInNewWindow(url, pushToast, tRef.current),
      createFileLinks: createTerminalFileLinks,
      scheduleRendererStyleCorrection: layout.scheduleRendererStyleCorrection,
      clearRendererCache: layout.clearTerminalRendererCache,
      recordRenderer: (renderer) => recordMobileDebug('terminal-renderer', { renderer }),
    })
    if (!core || disposed) return
    terminal = core.terminal
    layout.clearTerminalRendererCache()
    layout.scheduleRendererStyleCorrection()
    const fontReady = core.fontReady
    disposables.push(...core.disposables)
    terminalInstance.current = terminal
    ;(window as typeof window & { __tmuxgoTerminal?: any }).__tmuxgoTerminal = terminal
    void snapshotLoader.load()
    const da2Handler = terminal.parser?.registerCsiHandler?.({ prefix: '>', final: 'c' }, () => true)
    if (da2Handler) {
      disposables.push(da2Handler)
    }
    const osc52Handler = terminal.parser?.registerOscHandler?.(52, (data: string) => {
      const sep = data.indexOf(';')
      if (sep < 0) return true
      const base64 = data.slice(sep + 1)
      if (!base64) return true
      try {
        const text = decodeURIComponent(
          atob(base64)
            .split('')
            .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
            .join(''),
        )
        navigator.clipboard?.writeText(text)
      } catch {}
      return true
    })
    if (osc52Handler) {
      disposables.push(osc52Handler)
    }
    layout.scheduleInitialFit()
    layout.scheduleTerminalRepaint(
      isMobileDevice ? layout.delays.MOBILE_TERMINAL_REPAINT_DELAYS : layout.delays.TERMINAL_REPAINT_DELAYS,
      false,
      false,
      true,
    )
    void fontReady.then(() => {
      if (disposed || terminalInstance.current !== terminal) return
      layout.applyTerminalOptions()
      layout.clearTerminalRendererCache()
      try {
        terminal.refresh(0, Math.max(0, terminal.rows - 1))
      } catch {}
      layout.scheduleLayoutSync(0, true, true)
      layout.scheduleFontLayout()
      layout.scheduleTerminalRepaint(
        isMobileDevice ? layout.delays.MOBILE_TERMINAL_REPAINT_DELAYS : layout.delays.TERMINAL_REPAINT_DELAYS,
        false,
        false,
        true,
      )
    })
    disposables.push(
      terminal.onData((data: string) => {
        onInputRef.current?.(data)
      }),
    )
    terminal.attachCustomKeyEventHandler(
      createTerminalKeyEventHandler({
        getSelectionText,
        runCopySelection: selectionSync.runCopySelection,
        scheduleKeyboardPasteFallback: pasteBridge.scheduleKeyboardPasteFallback,
        sendInput: (data) => onInputRef.current?.(data),
        startDeleteWordRepeat: deleteWordRepeat.start,
        isDeleteWordRepeatActive: deleteWordRepeat.isActive,
        focusTerminalInput: focus.focusTerminalInput,
      }),
    )
    disposables.push(
      terminal.onSelectionChange(() => {
        const selection = getSelectionText()
        selectionSync.setSelection(selection)
      }),
    )
    let unsubscribeOutput = () => {}
    const subscribeTerminalOutput = () => {
      unsubscribeOutput()
      const hostId = activeHostIdRef.current || 'local'
      const targetSessionName = sessionNameRef.current || ''
      unsubscribeOutput = targetSessionName
        ? subscribeOutputRef.current(hostId, targetSessionName, outputInput.handleOutput)
        : () => {}
    }
    resubscribeOutputRef.current = subscribeTerminalOutput
    subscribeTerminalOutput()
    const handleCopySelection = (event: Event) => {
      const selection = getSelectionText()
      window.dispatchEvent(
        new CustomEvent('tmuxgo-terminal-selection', {
          detail: { requestId: (event as CustomEvent).detail?.requestId, selection },
        }),
      )
    }
    window.addEventListener('tmuxgo-copy-terminal-selection', handleCopySelection as EventListener)
    const handleWindowResize = () => layout.notifyWindowResize()
    const handleKeyUp = (e: KeyboardEvent) => {
      recordImeDebug('window-keyup', {
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        isComposing: e.isComposing,
      })
      if (e.key === 'Backspace' || !e.ctrlKey) deleteWordRepeat.stop()
    }
    const handleOrientationChange = () => {
      layout.setMobileKeyboardTransition(true)
      layout.softRecoverTerminalScreen('orientationchange', true)
    }
    let lastKeyboardOpen = document.body.classList.contains('keyboard-open')
    const handleKeyboardChange = (event: Event) => {
      const detail = (event as CustomEvent<{ open?: boolean }>).detail
      const nextOpen =
        typeof detail?.open === 'boolean' ? detail.open : document.body.classList.contains('keyboard-open')
      if (nextOpen === lastKeyboardOpen) return
      lastKeyboardOpen = nextOpen
      if (isMobileDevice) cancelTmuxCopyMode()
      if (isMobileDevice && attachExclusiveRef.current) layout.setMobileKeyboardTransition(true)
    }
    const handleAttached = (event: Event) => {
      const detail = (event as CustomEvent).detail || {}
      if (detail.hostId && detail.hostId !== (activeHostIdRef.current || 'local')) return
      if (detail.sessionName && detail.sessionName !== sessionNameRef.current) return
      const cols = Number(detail.cols)
      const rows = Number(detail.rows)
      if (!terminal || disposed) return
      const hadOutputBeforeAttach = outputInput.consumeAttachOutputFlag()
      attachEventCount += 1
      const initialAttach = attachEventCount === 1
      const softRecover = initialAttach && hadOutputBeforeAttach
      const snapshot = snapshotLoader.load()
      const generation = mask.getGeneration()
      void snapshot
        .catch(() => null)
        .then(() => {
          if (
            !mask.isPending() ||
            disposed ||
            generation !== mask.getGeneration() ||
            cols !== terminal?.cols ||
            rows !== terminal?.rows
          )
            return
          mask.reveal(generation)
        })
      if (attachExclusiveRef.current) {
        const size = lastSizeRef.current
        const sizeChanged = !size || size.cols !== cols || size.rows !== rows
        if (sizeChanged) layout.scheduleInitialFit()
        if (softRecover)
          layout.scheduleTerminalRepaint(
            isMobileDevice ? layout.delays.MOBILE_TERMINAL_REPAINT_DELAYS : layout.delays.TERMINAL_REPAINT_DELAYS,
          )
        else if (sizeChanged) layout.softRecoverTerminalScreen('attached', true)
        return
      }
      if (cols > 0 && rows > 0) {
        const prevSharedSize = sharedSessionSizeRef.current
        const sizeChanged = !prevSharedSize || prevSharedSize.cols !== cols || prevSharedSize.rows !== rows
        sharedSessionSizeRef.current = { cols, rows }
        if (sizeChanged) layout.scheduleLayoutSync(0, true, true)
        if (softRecover)
          layout.scheduleTerminalRepaint(
            isMobileDevice ? layout.delays.MOBILE_TERMINAL_REPAINT_DELAYS : layout.delays.TERMINAL_REPAINT_DELAYS,
          )
        else if (sizeChanged) layout.softRecoverTerminalScreen('attached', true)
      }
    }
    const handleResized = (event: Event) => {
      const detail = (event as CustomEvent).detail || {}
      if (detail.hostId && detail.hostId !== (activeHostIdRef.current || 'local')) return
      if (detail.sessionName && detail.sessionName !== sessionNameRef.current) return
      const cols = Number(detail.cols)
      const rows = Number(detail.rows)
      if (!terminal || cols !== terminal.cols || rows !== terminal.rows || (detail.localOnly && !attachEventCount))
        return
      const generation = mask.getGeneration()
      if (detail.localOnly) {
        mask.reveal(generation)
        return
      }
      void snapshotLoader.load(true).catch(() => null)
      if (disposed || generation !== mask.getGeneration() || cols !== terminal?.cols || rows !== terminal?.rows) return
      mask.reveal(generation)
    }
    const handleResizeAbort = (event: Event) => {
      const detail = (event as CustomEvent).detail || {}
      if (detail.hostId && detail.hostId !== (activeHostIdRef.current || 'local')) return
      if (detail.sessionName && detail.sessionName !== sessionNameRef.current) return
      if (mask.isPending()) mask.reveal()
    }
    const handleLayoutChange = (event: Event) => {
      const detail = (event as CustomEvent).detail || {}
      if (detail.reason === 'attached') return
      if (focus.isComposing() || document.body.classList.contains('ime-composing')) return
      const mobileKeyboardLayout = isMobileDevice && detail.reason === 'viewport-sync'
      const stickToBottom = isMobileDevice && (detail.keyboardOpen || !layout.isTerminalScrolledBack())
      if (mobileKeyboardLayout) {
        layout.setMobileKeyboardTransition(true)
        layout.scheduleTerminalRepaint(
          layout.delays.MOBILE_TERMINAL_KEYBOARD_REPAINT_DELAYS,
          false,
          stickToBottom,
          true,
        )
        return
      }
      if (detail.reason === 'terminal-panel-resize-end') {
        layout.scheduleLayoutSync(0, true, true)
        layout.scheduleTerminalRepaint(layout.delays.LAYOUT_REPAINT_DELAYS)
        return
      }
      if (detail.reason === 'tmux-pane-resize') {
        layout.scheduleTerminalRepaint(layout.delays.LAYOUT_REPAINT_DELAYS)
        return
      }
      layout.scheduleTerminalRepaint(
        isMobileDevice ? layout.delays.MOBILE_TERMINAL_REPAINT_DELAYS : layout.delays.LAYOUT_REPAINT_DELAYS,
        false,
        stickToBottom,
      )
    }
    const handleVisibilityChange = () => {
      if (document.hidden) {
        deleteWordRepeat.stop()
        return
      }
      const recovered = layout.syncRenderEnvironment('visibilitychange')
      layout.scheduleLayoutSync(0, true)
      if (isMobileDevice && !recovered) {
        layout.recoverTerminalScreen('visibilitychange')
        return
      }
      if (recovered) return
      layout.scheduleTerminalRepaint(
        isMobileDevice ? layout.delays.MOBILE_TERMINAL_REPAINT_DELAYS : layout.delays.TERMINAL_REPAINT_DELAYS,
      )
    }
    const handlePageShow = () => {
      const recovered = layout.syncRenderEnvironment('pageshow')
      layout.scheduleLayoutSync(0, true)
      if (isMobileDevice && !recovered) layout.recoverTerminalScreen('pageshow')
    }
    window.addEventListener('tmux-attached', handleAttached as EventListener)
    window.addEventListener('tmux-resized', handleResized as EventListener)
    window.addEventListener('tmux-error', handleResizeAbort as EventListener)
    window.addEventListener('tmux-detached', handleResizeAbort as EventListener)
    window.addEventListener('tmuxgo-layout-change', handleLayoutChange as EventListener)
    window.addEventListener('resize', handleWindowResize)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', deleteWordRepeat.stop)
    window.addEventListener('orientationchange', handleOrientationChange)
    window.addEventListener('mobile-keyboard-change', handleKeyboardChange as EventListener)
    window.addEventListener('pageshow', handlePageShow)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    const handleDragLeave = (e: DragEvent) => {
      dropState.handleDragLeave(e, container)
    }
    paneResize.attach()
    container.addEventListener('dragover', dropState.handleDragOver)
    container.addEventListener('dragleave', handleDragLeave)
    container.addEventListener('drop', dropState.handleDrop)
    const handleCopy = (e: ClipboardEvent) => {
      selectionSync.handleNativeCopyEvent(getSelectionText(), e)
    }
    helperTextarea = terminal.textarea
    focus.setHelperTextarea(helperTextarea)
    const handlePointerSync = (event?: MouseEvent | TouchEvent) => {
      if (!outputInput.isPointerSyncActive()) return
      outputInput.disarmPointerSync()
      if (focus.isDesktopImeComposing()) return
      outputInput.flushWriteBuffer()
      selectionSync.clearCopySelectionTimer()
      selectionSync.runCopySelection(
        getSelectionText() || selectionSync.currentSelectionRef.current,
        true,
        true,
        focus.focusTerminalInput,
      )
      if (event instanceof MouseEvent) {
        const paneId = getPaneIdByMouseCell(getMouseCell(event))
        if (paneId) {
          setActivePane(paneId)
          void api.panes.select(paneId).catch(() => {})
        }
      }
      void syncActivePane()
    }
    const handleFocusTerminal = () => {
      if (focus.isDesktopImeComposing()) return
      focus.focusTerminalInput()
      requestAnimationFrame(() => {
        if (!focus.isDesktopImeComposing()) focus.focusTerminalInput()
      })
      setTimeout(() => {
        if (!focus.isDesktopImeComposing()) focus.focusTerminalInput()
      }, 0)
    }
    const clipboardIme = createTerminalClipboardIme({
      container,
      helperTextarea,
      handleCopy,
      handleCompositionStart: imeHandlers.handleCompositionStart,
      handleCompositionUpdate: imeHandlers.handleCompositionUpdate,
      handleCompositionEnd: imeHandlers.handleCompositionEnd,
      handleFocus: imeHandlers.handleFocus,
      handleBlur: imeHandlers.handleBlur,
      handleBeforeInput: imeHandlers.handleBeforeInput,
      handleInput: imeHandlers.handleInput,
      handleKeyDown: imeHandlers.handleKeyDown,
      handleKeyUp: imeHandlers.handleKeyUp,
      handlePaste: pasteBridge.handlePaste as EventListener,
      handlePasteInput: pasteBridge.handlePasteInput as EventListener,
      armPointerSync: outputInput.armPointerSync,
      handlePointerSync: handlePointerSync as (event?: MouseEvent | TouchEvent) => void,
      clearPointerSync: outputInput.clearPointerSync,
      handleFocusTerminal: handleFocusTerminal as EventListener,
    })
    clipboardIme.attach()
    disposables.push({
      dispose: () => {
        window.removeEventListener('tmux-attached', handleAttached as EventListener)
        window.removeEventListener('tmux-resized', handleResized as EventListener)
        window.removeEventListener('tmux-error', handleResizeAbort as EventListener)
        window.removeEventListener('tmux-detached', handleResizeAbort as EventListener)
        window.removeEventListener('tmuxgo-layout-change', handleLayoutChange as EventListener)
        resubscribeOutputRef.current = () => {}
        unsubscribeOutput()
        window.removeEventListener('tmuxgo-copy-terminal-selection', handleCopySelection as EventListener)
        window.removeEventListener('resize', handleWindowResize)
        window.removeEventListener('keyup', handleKeyUp)
        window.removeEventListener('blur', deleteWordRepeat.stop)
        window.removeEventListener('orientationchange', handleOrientationChange)
        window.removeEventListener('mobile-keyboard-change', handleKeyboardChange as EventListener)
        window.removeEventListener('pageshow', handlePageShow)
        document.removeEventListener('visibilitychange', handleVisibilityChange)
        paneResize.dispose()
        container.removeEventListener('dragover', dropState.handleDragOver)
        container.removeEventListener('dragleave', handleDragLeave)
        container.removeEventListener('drop', dropState.handleDrop)
        clipboardIme.dispose()
        selectionSync.clearCopySelectionTimer()
        pasteBridge.dispose()
        selectionSync.dispose()
      },
    })
    layout.primeContainerSize()
    resizeObserver = new ResizeObserver(() => layout.notifyObservedResize())
    resizeObserver.observe(container)
    container.addEventListener('touchstart', pinch.handleTouchStart, { passive: true })
    container.addEventListener('touchmove', pinch.handleTouchMove, { passive: false })
    container.addEventListener('touchend', pinch.handleTouchEnd, { passive: true })
    container.addEventListener('touchcancel', pinch.handleTouchCancel, { passive: true })
    container.addEventListener('wheel', pinch.handleDesktopPinch, { capture: true, passive: false })
    container.addEventListener('touchstart', touchScroll.handleTouchStart, { passive: true })
    container.addEventListener('touchmove', touchScroll.handleTouchMove, { passive: false })
    container.addEventListener('touchend', touchScroll.handleTouchEnd, { passive: true })
    container.addEventListener('touchcancel', touchScroll.handleTouchCancel, { passive: true })
    const blockMobileBrowserGesture = (event: Event) => {
      if (!isMobileDevice) return
      event.preventDefault()
      event.stopPropagation()
    }
    if (isMobileDevice) {
      container.addEventListener('contextmenu', blockMobileBrowserGesture, true)
      container.addEventListener('selectstart', blockMobileBrowserGesture, true)
    }
    disposables.push({
      dispose: () => {
        container.removeEventListener('touchstart', pinch.handleTouchStart)
        container.removeEventListener('touchmove', pinch.handleTouchMove)
        container.removeEventListener('touchend', pinch.handleTouchEnd)
        container.removeEventListener('touchcancel', pinch.handleTouchCancel)
        container.removeEventListener('wheel', pinch.handleDesktopPinch, true)
        touchScroll.dispose()
        container.removeEventListener('touchstart', touchScroll.handleTouchStart)
        container.removeEventListener('touchmove', touchScroll.handleTouchMove)
        container.removeEventListener('touchend', touchScroll.handleTouchEnd)
        container.removeEventListener('touchcancel', touchScroll.handleTouchCancel)
        if (isMobileDevice) {
          container.removeEventListener('contextmenu', blockMobileBrowserGesture, true)
          container.removeEventListener('selectstart', blockMobileBrowserGesture, true)
        }
      },
    })
    if (disposed) return
    if (!attachExclusiveRef.current) {
      notifyReady()
    }
  }
  afterTerminalWriteRef.current = () => {
    if (!attachExclusiveRef.current && isMobileDevice) requestAnimationFrame(layout.syncSharedViewport)
    if (isMobileDevice && document.body.classList.contains('keyboard-open') && !layout.isTerminalScrolledBack())
      requestAnimationFrame(layout.scrollTerminalToBottom)
  }
  void initTerminal().catch(console.error)
  const dispose = () => {
    disposed = true
    deleteWordRepeat.stop()
    paneResize.hide()
    layout.dispose()
    mask.dispose()
    imeHandlers.dispose()
    afterTerminalWriteRef.current = () => {}
    disposeTerminalOutput()
    resizeObserver?.disconnect()
    disposables.forEach((d) => d?.dispose?.())
    document.body.classList.remove('ime-composing')
    terminal?.dispose()
    terminalInstance.current = null
    scheduleLayoutRef.current = () => {}
  }
  return { dispose }
}
