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
import { subscribeStreamEvent, STREAM_EVENT } from './stream-events'
import type { useTranslation } from '@/i18n'
import type { FileDocumentHandle, FileRoot } from '@/types'
const SCROLLBACK_LIMIT = 600
// 切换攒流的静默窗口：attached 后每条输出重置该计时，静默 40ms 视为本批齐了——
// 能把 gateway attach 后 48ms 的 refresh-client 重绘（ATTACH_REDRAW_DELAYS）并进同一笔 write。
const SWITCH_FLUSH_QUIET_MS = 40
// 从 attached 起的最长攒流窗口，防止嘈杂 session 的输出不断重置静默计时而迟迟不揭罩。
const SWITCH_FLUSH_CAP_MS = 200
// attach 始终不出输出时的兜底：超时照常 flush，退化为旧的清屏行为。
const SWITCH_HOLD_TIMEOUT_MS = 800
const SWITCH_CLEAR_SEQ = '\x1b[3J\x1b[2J\x1b[H'
interface TerminalRuntimeOptions {
  container: HTMLElement
  isMobile: boolean
  terminalInstance: { current: any }
  onInputRef: { current: ((data: string) => void) | undefined }
  onResizeRef: { current: ((cols: number, rows: number) => void) | undefined }
  onResizeActivityRef?: { current: (() => void) | undefined }
  // 供上层判断"本地 fit 是否仍在落地"（含稳定帧窗口）：远端 resize 发送须等它归零
  layoutSyncPendingRef?: { current: (() => boolean) | undefined }
  // pointer settle 提交用：同步读当前容器几何的目标行列，替代等 fit 管线收尾
  peekFitSizeRef?: { current: (() => { cols: number; rows: number } | null) | undefined }
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
  switchVeilElement: HTMLElement | null
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
  // 输出写屏障：cb 在已排队输出全部写进 xterm 后调用（scheduler 内有界等待）
  afterOutputWrites: (cb: () => void) => void
  beginSessionSwitchRef: { current: () => void }
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
  let switchAttachedSeen = false
  let switchBeganAt = 0
  let switchAttachedAt = 0
  let switchFlushTimer: ReturnType<typeof setTimeout> | null = null
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
  // 已发送未确认的最近一次 resize 请求（resized ACK 无代次，只能按尺寸对末次消歧；
  // 同尺寸旧 ACK 无法区分但语义等价——服务端已到该尺寸即可揭）
  const pendingRemoteResizeRef: { current: { cols: number; rows: number } | null } = { current: null }
  // resized/本地 fit 只代表"尺寸已改"：此前排队的输出可能仍在 scheduler backlog
  // 或 xterm.write 回调途中，先揭罩会把旧列宽帧闪进新网格。
  // 统一等输出写屏障落地再揭，并用代次+尺寸复核丢弃过期请求
  const revealMaskAfterWrites = (generation: number, matches: () => boolean = () => true) => {
    options.afterOutputWrites(() => {
      if (disposed || !mask.isPending() || generation !== mask.getGeneration() || !matches()) return
      mask.reveal(generation)
    })
  }
  // 切换遮罩与 resize 遮罩用同工厂但独立实例：切换有自己的揭开时机（新帧写完），
  // 不能跟 resize 的 reveal 路径互相干扰
  const switchMask = createTerminalResizeMask({ mask: options.switchVeilElement, getTerminal })
  const layout = createTerminalLayout({
    container,
    isMobile: isMobileDevice,
    getTerminal,
    isDisposed,
    preferencesRef,
    attachExclusiveRef,
    lastSizeRef,
    sharedSessionSizeRef,
    pendingRemoteResizeRef,
    onResizeRef,
    onResizeActivityRef: options.onResizeActivityRef,
    controlCarryRef,
    mask,
    revealMask: (generation) => revealMaskAfterWrites(generation ?? mask.getGeneration()),
    getTerminalPerf: options.getTerminalPerf,
    updateTerminalPerf,
    notifyReady,
    requestServerRedraw,
  })
  scheduleLayoutRef.current = layout.scheduleLayoutSync
  if (options.layoutSyncPendingRef) options.layoutSyncPendingRef.current = layout.isSyncPending
  if (options.peekFitSizeRef) options.peekFitSizeRef.current = layout.peekFitSize
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
    onOutput: () => {
      if (outputInput.isSwitchHolding() && switchAttachedSeen) armSwitchFlush()
    },
    writeAtomic: (data) => {
      getTerminal()?.write?.(data, () => {
        afterTerminalWriteRef.current()
        // 新帧解析+上屏完成后才揭开遮罩（reveal 内部再等两帧动画）
        switchMask.reveal()
      })
    },
    controlCarryRef,
  })
  const finishSessionSwitch = () => {
    if (switchFlushTimer) {
      clearTimeout(switchFlushTimer)
      switchFlushTimer = null
    }
    if (!outputInput.isSwitchHolding()) return
    // 尺寸协商（resize/fontScale 的 rAF 链）还在途就写帧，揭开遮罩后会再 reflow——
    // 表现为"先 resize 到某个尺寸再回到实际尺寸"。等它落地再 flush，超时就放弃等。
    if (layout.isSyncPending() && Date.now() - switchBeganAt < SWITCH_HOLD_TIMEOUT_MS) {
      switchFlushTimer = setTimeout(finishSessionSwitch, 16)
      return
    }
    switchAttachedSeen = false
    if (outputInput.hasSwitchBuffered()) {
      outputInput.flushSwitchHold(SWITCH_CLEAR_SEQ)
      return
    }
    // 没有攒到帧（attach/resync 未回或丢失）时不能光写清屏序列——那会把完好的
    // 旧帧抹成空白直到下次输出。结束 hold 并主动拉一帧回来
    outputInput.flushSwitchHold()
    switchMask.reveal()
    requestServerRedraw()
  }
  const armSwitchFlush = () => {
    if (switchFlushTimer) clearTimeout(switchFlushTimer)
    const elapsed = Date.now() - switchAttachedAt
    switchFlushTimer = setTimeout(
      finishSessionSwitch,
      Math.max(0, Math.min(SWITCH_FLUSH_QUIET_MS, SWITCH_FLUSH_CAP_MS - elapsed)),
    )
  }
  const beginSessionSwitch = () => {
    if (disposed || !terminal) return
    // 不盖遮罩：hold 期间 xterm 本就保持旧帧原样，原子写一笔换帧；
    // WebGL canvas 克隆有色彩管理失真（灰→黑），同尺寸切换不需要它
    disposeTerminalOutput()
    outputInput.beginSwitchHold()
    switchAttachedSeen = false
    switchBeganAt = Date.now()
    switchAttachedAt = 0
    if (switchFlushTimer) clearTimeout(switchFlushTimer)
    // attach 失败/无输出的兜底，见 SWITCH_HOLD_TIMEOUT_MS 注释
    switchFlushTimer = setTimeout(finishSessionSwitch, SWITCH_HOLD_TIMEOUT_MS)
  }
  options.beginSessionSwitchRef.current = beginSessionSwitch
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
        if (selection) outputInput.holdSelection()
        else outputInput.releaseSelection()
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
    }
    const handleAttached = (detail: any = {}) => {
      if (detail.hostId && detail.hostId !== (activeHostIdRef.current || 'local')) return
      if (detail.sessionName && detail.sessionName !== sessionNameRef.current) return
      // 新 attach 上下文里旧 session 的在途 resize 已无意义
      pendingRemoteResizeRef.current = null
      const cols = Number(detail.cols)
      const rows = Number(detail.rows)
      if (!terminal || disposed) return
      const hadOutputBeforeAttach = outputInput.consumeAttachOutputFlag()
      const switching = outputInput.isSwitchHolding()
      if (switching) {
        switchAttachedSeen = true
        switchAttachedAt = Date.now()
        // 已攒到首帧 → 进入静默合并窗口；没攒到 → 保留 beginSessionSwitch 的兜底定时器
        if (outputInput.hasSwitchBuffered()) armSwitchFlush()
      }
      attachEventCount += 1
      const initialAttach = attachEventCount === 1
      const softRecover = initialAttach && hadOutputBeforeAttach
      if (switching) {
        // 攒流期间只做尺寸协商。尺寸要变时先定格旧帧盖住 reflow/字体缩放；
        // 同尺寸切换无遮罩——克隆 WebGL canvas 有色彩失真，且本身多余。
        // snapshot 拉取和恢复性 repaint 一律跳过：flush 写回的帧即权威画面，
        // 它们若揭开后落屏 = 二次重绘 + 字形重栅格化（先粗后细）。
        const willResize = cols > 0 && rows > 0 && (cols !== terminal.cols || rows !== terminal.rows)
        if (attachExclusiveRef.current) {
          const size = lastSizeRef.current
          const sizeChanged = !size || size.cols !== cols || size.rows !== rows
          if (willResize) switchMask.show()
          if (sizeChanged) layout.scheduleInitialFit()
          return
        }
        if (cols > 0 && rows > 0) {
          const prevSharedSize = sharedSessionSizeRef.current
          const sizeChanged = !prevSharedSize || prevSharedSize.cols !== cols || prevSharedSize.rows !== rows
          sharedSessionSizeRef.current = { cols, rows }
          if (willResize) switchMask.show()
          if (sizeChanged) layout.scheduleLayoutSync(0, true, true)
        }
        return
      }
      const snapshot = snapshotLoader.load()
      const generation = mask.getGeneration()
      void snapshot
        .catch(() => null)
        .then(() => {
          revealMaskAfterWrites(generation, () => cols === terminal?.cols && rows === terminal?.rows)
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
    const handleResized = (detail: any = {}) => {
      if (detail.hostId && detail.hostId !== (activeHostIdRef.current || 'local')) return
      if (detail.sessionName && detail.sessionName !== sessionNameRef.current) return
      const cols = Number(detail.cols)
      const rows = Number(detail.rows)
      // resized（含 localOnly）= 一次 resize 请求的确认：与在途尺寸匹配即清，
      // 不匹配的是过期 ACK（A->B->A 中的旧 B），保持 pending 等末次确认
      const pending = pendingRemoteResizeRef.current
      if (pending && pending.cols === cols && pending.rows === rows) pendingRemoteResizeRef.current = null
      if (!terminal || cols !== terminal.cols || rows !== terminal.rows || (detail.localOnly && !attachEventCount))
        return
      const generation = mask.getGeneration()
      if (detail.localOnly) {
        mask.reveal(generation)
        return
      }
      void snapshotLoader.load(true).catch(() => null)
      if (disposed || generation !== mask.getGeneration() || cols !== terminal?.cols || rows !== terminal?.rows) return
      // 屏障期间尺寸可能又变了（如快速 A->B->A 后到达的旧 ACK）：回调里复核
      revealMaskAfterWrites(generation, () => cols === terminal?.cols && rows === terminal?.rows)
    }
    const handleResizeAbort = (detail: any = {}) => {
      if (detail.hostId && detail.hostId !== (activeHostIdRef.current || 'local')) return
      if (detail.sessionName && detail.sessionName !== sessionNameRef.current) return
      // error/detached 后不会再有 resized ACK：清在途标记让遮罩走兜底揭开
      pendingRemoteResizeRef.current = null
      if (mask.isPending()) mask.reveal()
      finishSessionSwitch()
    }
    const handleLayoutChange = (event: Event) => {
      const detail = (event as CustomEvent).detail || {}
      if (detail.reason === 'attached') return
      if (focus.isComposing() || document.body.classList.contains('ime-composing')) return
      const mobileKeyboardLayout = isMobileDevice && detail.reason === 'viewport-sync'
      const stickToBottom = isMobileDevice && (detail.keyboardOpen || !layout.isTerminalScrolledBack())
      if (mobileKeyboardLayout) {
        // 键盘开合不再升级 force fit：容器尺寸变化的普通 fit 已足够，
        // 强制路径会多一次字形图集清空+全量重绘（用户看到的二次刷新）
        layout.scheduleTerminalRepaint(layout.delays.MOBILE_TERMINAL_KEYBOARD_REPAINT_DELAYS, false, stickToBottom)
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
        // 前台恢复必须非破坏：recoverTerminalScreen 会 clear+reset 清 buffer，
        // serverRedraw=false 时静态 session 无人补帧 → 空白到下次输出。buffer
        // 未坏时用 soft 恢复（清 renderer 缓存+重绘）即可还原画面
        layout.softRecoverTerminalScreen('visibilitychange')
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
      if (isMobileDevice && !recovered) layout.softRecoverTerminalScreen('pageshow')
    }
    const streamEventUnsubs = [
      subscribeStreamEvent(STREAM_EVENT.attached, handleAttached),
      subscribeStreamEvent(STREAM_EVENT.resized, handleResized),
      subscribeStreamEvent(STREAM_EVENT.error, handleResizeAbort),
      subscribeStreamEvent(STREAM_EVENT.detached, handleResizeAbort),
      // pointerup 后不等 2 帧稳定检测链（~48ms）——16ms 后（React 提交+RO 送达
      // 已覆盖）直接调度 fit，让最终尺寸在 ~60ms 内进入 PaneGrid 提交窗口
      subscribeStreamEvent(STREAM_EVENT.resizeGesture, (detail: { phase?: string } = {}) => {
        if (detail?.phase === 'end') layout.scheduleLayoutSync(16, true)
      }),
    ]
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
      if (!getSelectionText()) outputInput.releaseSelection()
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
        for (const unsub of streamEventUnsubs) unsub()
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
    const armSelectionHold = (event: MouseEvent | TouchEvent) => {
      if (event instanceof MouseEvent && event.button !== 0) return
      outputInput.holdSelection()
    }
    container.addEventListener('mousedown', armSelectionHold)
    container.addEventListener('touchstart', armSelectionHold, { passive: true })
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
        container.removeEventListener('mousedown', armSelectionHold)
        container.removeEventListener('touchstart', armSelectionHold)
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
    if (switchFlushTimer) {
      clearTimeout(switchFlushTimer)
      switchFlushTimer = null
    }
    deleteWordRepeat.stop()
    paneResize.hide()
    layout.dispose()
    mask.dispose()
    switchMask.dispose()
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
