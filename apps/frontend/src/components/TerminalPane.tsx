'use client'
import { useEffect, useRef, useCallback } from 'react'
import '@xterm/xterm/css/xterm.css'
import { usePreferences, ensureAppFontLoaded } from '@/hooks/usePreferences'
import { useMobileKeyboard } from '@/hooks/useMobileKeyboard'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { api } from '@/lib/api'
import { useTerminalOutput } from '@/hooks/useTerminalOutput'
import { useTerminalDrop } from '@/hooks/useTerminalDrop'
import { useTerminalPasteBridge } from '@/hooks/useTerminalPasteBridge'
import { useOptionalQueryClient } from '@/hooks/useOptionalQueryClient'
import { useTerminalSelectionSync } from '@/hooks/useTerminalSelectionSync'
import { useTranslation } from '@/i18n'
import { useTerminalTouchScroll } from '@/hooks/useTerminalTouchScroll'
import { useSessionSnapshotSync } from '@/hooks/useSessionSnapshotSync'
import { useTerminalOutputScheduler } from '@/hooks/useTerminalOutputScheduler'
import { useTerminalPinch } from '@/hooks/useTerminalPinch'
import { useGithubDeviceLogin } from '@/hooks/useGithubDeviceLogin'
import { createTerminalRuntime } from '@/lib/terminal-runtime'
import { createTerminalResizeMask } from '@/lib/terminal-resize-mask'
import { Chip } from './Chip'
import type { FileRoot } from '@/types'
const DEFAULT_TERMINAL_PERF = {
  attachLatency: 0,
  outputBytes: 0,
  outputEvents: 0,
  outputBacklog: 0,
  layoutFitCount: 0,
  lastOutputAt: '',
}
interface TerminalPaneProps {
  sessionName?: string
  onInput?: (data: string) => void
  onResize?: (cols: number, rows: number) => void
  attachExclusive?: boolean
  onReady?: () => void
  subscribeOutput?: (
    hostId: string,
    sessionName: string,
    listener: (message: {
      data: string
      sessionName?: string | null
      hostId?: string | null
      resync?: boolean
    }) => void,
  ) => () => void
  send?: (data: any) => boolean
  onSwipeLeft?: () => void
  onSwipeRight?: () => void
}
export function TerminalPane({
  sessionName,
  onInput,
  onResize,
  attachExclusive = false,
  onReady,
  subscribeOutput,
  send: sendProp,
  onSwipeLeft,
  onSwipeRight,
}: TerminalPaneProps) {
  const { preferences, updatePreferences, isReady: preferencesReady = true } = usePreferences()
  const { t } = useTranslation()
  const activeHostId = useConsoleStore((s) => s.activeHostId)
  const pushToast = useConsoleStore((s) => s.pushToast)
  const openUploadDialog = useConsoleStore((s) => s.openUploadDialog)
  const setActivePane = useConsoleStore((s) => s.setActivePane)
  const { optimisticallyToggleWindowZoom, discardOptimisticWindowZoom, refreshSnapshot } = useSessionSnapshotSync()
  const resolvePaneAtPointRef = useRef<(x: number, y: number) => string | null>(() => null)
  const zoomInFlightRef = useRef(false)
  const updateTerminalPerf = useConsoleStore((s) => s.updateTerminalPerf)
  const recordTerminalOutput = useTerminalOutput()
  const queryClient = useOptionalQueryClient()
  const terminalRef = useRef<HTMLDivElement>(null)
  const paneResizeGuideRef = useRef<HTMLDivElement>(null)
  const resizeMaskRef = useRef<HTMLDivElement>(null)
  const switchVeilRef = useRef<HTMLDivElement>(null)
  const resizeMaskApiRef = useRef<ReturnType<typeof createTerminalResizeMask> | null>(null)
  const touchMovedRef = useRef(false)
  const terminalInstance = useRef<any>(null)
  const onInputRef = useRef(onInput)
  const onResizeRef = useRef(onResize)
  const attachExclusiveRef = useRef(attachExclusive)
  const onReadyRef = useRef(onReady)
  const sessionNameRef = useRef(sessionName)
  const preferencesRef = useRef(preferences)
  const resubscribeOutputRef = useRef<() => void>(() => {})
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const sharedSessionSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const controlCarryRef = useRef('')
  const lastTapRef = useRef<{ x: number; y: number } | null>(null)
  const scheduleLayoutRef = useRef<(delay?: number, force?: boolean, resetFont?: boolean) => void>(() => {})
  const beginSessionSwitchRef = useRef<() => void>(() => {})
  const activeHostIdRef = useRef(activeHostId)
  const updatePreferencesRef = useRef(updatePreferences)
  const tRef = useRef(t)
  const afterTerminalWriteRef = useRef<() => void>(() => {})
  const fileRootsRef = useRef<FileRoot[] | null>(null)
  const fileRootsHostIdRef = useRef('')
  const paneCwdRef = useRef<string>('')
  const {
    githubDeviceLogin,
    dismissGithubDeviceLogin,
    openGithubDeviceLogin,
    copyGithubDeviceLogin,
    updateGithubDeviceLogin,
  } = useGithubDeviceLogin({ activeHostId: activeHostId || 'local', sessionName })
  const ensureFileRoots = useCallback(async () => {
    const hostId = activeHostIdRef.current || 'local'
    if (fileRootsRef.current && fileRootsHostIdRef.current === hostId) return fileRootsRef.current
    const roots = await api.files.roots(hostId)
    fileRootsRef.current = roots
    fileRootsHostIdRef.current = hostId
    return roots
  }, [])
  const syncPaneCwd = useCallback(async () => {
    const paneId = useConsoleStore.getState().activePaneId
    if (!paneId) return paneCwdRef.current
    try {
      const target = await api.files.defaultUploadTarget(activeHostIdRef.current || 'local', paneId)
      paneCwdRef.current = target?.absolutePath || paneCwdRef.current
    } catch {}
    return paneCwdRef.current
  }, [])
  const dispatchTerminalTap = useCallback((x: number, y: number) => {
    const container = terminalRef.current
    if (!container) return
    const target =
      typeof document.elementFromPoint === 'function' ? (document.elementFromPoint(x, y) as HTMLElement | null) : null
    const terminalTarget =
      target?.closest('.xterm-screen') ||
      target?.closest('.xterm') ||
      container.querySelector('.xterm-screen') ||
      container.querySelector('.xterm')
    if (!(terminalTarget instanceof HTMLElement)) return
    const options = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, composed: true }
    terminalTarget.dispatchEvent(new MouseEvent('mousemove', options))
    terminalTarget.dispatchEvent(new MouseEvent('mousedown', options))
    terminalTarget.dispatchEvent(new MouseEvent('mouseup', { ...options, buttons: 0 }))
    terminalTarget.dispatchEvent(new MouseEvent('click', { ...options, buttons: 0, detail: 1 }))
  }, [])
  const { send: defaultSend, subscribeOutput: subscribeWebSocketOutput } = useWebSocket()
  const send = sendProp || defaultSend
  const subscribeOutputRef = useRef(subscribeOutput || subscribeWebSocketOutput)
  const sendRef = useRef(send)
  const sendInput = useCallback((data: string) => onInputRef.current?.(data), [])
  const { textareaRef, focusKeyboard, isMobile: isMobileDevice } = useMobileKeyboard(sendInput, terminalRef)
  const dropState = useTerminalDrop(sendInput, openUploadDialog, () => terminalInstance.current?.focus?.())
  const handlePasteFiles = useCallback(
    (files: File[]) => openUploadDialog({ files, insertPaths: true, temporary: true }),
    [openUploadDialog],
  )
  const pasteBridge = useTerminalPasteBridge(handlePasteFiles)
  const selectionSync = useTerminalSelectionSync(pushToast)
  const writeTerminalOutput = useCallback((chunk: string, done?: () => void) => {
    const terminal = terminalInstance.current
    if (!terminal?.write) {
      done?.()
      return
    }
    try {
      if (terminal.write.length >= 2) terminal.write(chunk, done)
      else {
        terminal.write(chunk)
        done?.()
      }
    } catch {
      done?.()
    }
  }, [])
  const handleTerminalWriteComplete = useCallback(() => {
    afterTerminalWriteRef.current()
  }, [])
  const handleTerminalMetrics = useCallback(
    (raw: string, outputLength: number, backlogLength: number) => {
      recordTerminalOutput(
        useConsoleStore.getState().terminalPerf || DEFAULT_TERMINAL_PERF,
        raw,
        outputLength,
        backlogLength,
      )
    },
    [recordTerminalOutput],
  )
  const handleTerminalBackpressure = useCallback(
    (level: 'high' | 'normal', backlog: number, stats?: { inFlight: number; oldestAgeMs: number }) => {
      updateTerminalPerf({
        outputBacklog: backlog,
        outputInFlight: stats?.inFlight ?? 0,
        outputOldestAgeMs: Math.round(stats?.oldestAgeMs ?? 0),
      })
      sendRef.current({ type: 'stream_backpressure', level, mobile: isMobileDevice })
    },
    [isMobileDevice, updateTerminalPerf],
  )
  const {
    push: pushTerminalOutput,
    dispose: disposeTerminalOutput,
    afterWrites: afterTerminalOutputWrites,
  } = useTerminalOutputScheduler({
    write: writeTerminalOutput,
    onWrite: handleTerminalWriteComplete,
    onMetrics: handleTerminalMetrics,
    onBackpressure: handleTerminalBackpressure,
  })
  const handleTouchScroll = useCallback(
    (lines: number) =>
      send({
        type: 'pane_scroll',
        hostId: activeHostIdRef.current || 'local',
        sessionName: sessionNameRef.current,
        lines,
      }),
    [send],
  )
  const handleTouchTap = useCallback((x: number, y: number) => {
    lastTapRef.current = { x, y }
  }, [])
  const handleTouchMovedChange = useCallback((moved: boolean) => {
    touchMovedRef.current = moved
  }, [])
  const {
    handleTouchStart: handlePinchTouchStart,
    handleTouchMove: handlePinchTouchMove,
    handleTouchEnd: handlePinchTouchEnd,
    handleTouchCancel: handlePinchTouchCancel,
    handleDesktopPinch,
  } = useTerminalPinch({
    isMobile: isMobileDevice,
    terminalRef: terminalInstance,
    preferencesRef,
    updatePreferencesRef,
    scheduleLayoutRef,
    touchMovedRef,
  })
  const zoomPaneById = useCallback(
    (paneId: string | null) => {
      if (!paneId || zoomInFlightRef.current) return
      setActivePane(paneId)
      zoomInFlightRef.current = true
      void (async () => {
        try {
          await api.panes.select(paneId).catch(() => {})
          optimisticallyToggleWindowZoom(paneId)
          await api.panes.zoomByPane(paneId)
          await refreshSnapshot().catch(() => {})
          window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'zoom-pane' } }))
        } catch (err) {
          discardOptimisticWindowZoom(paneId)
          await refreshSnapshot().catch(() => {})
          pushToast({ type: 'error', message: err instanceof Error ? err.message : tRef.current('pane.zoomFailed') })
        } finally {
          zoomInFlightRef.current = false
        }
      })()
    },
    [discardOptimisticWindowZoom, optimisticallyToggleWindowZoom, pushToast, refreshSnapshot, setActivePane],
  )
  const handleTwoFingerDoubleTap = useCallback(
    (x: number, y: number) => {
      const paneId = resolvePaneAtPointRef.current(x, y) || useConsoleStore.getState().activePaneId
      zoomPaneById(paneId)
    },
    [zoomPaneById],
  )
  const touchScroll = useTerminalTouchScroll({
    isMobile: isMobileDevice,
    onScroll: handleTouchScroll,
    onTap: handleTouchTap,
    onTouchMovedChange: handleTouchMovedChange,
    onSwipeLeft,
    onSwipeRight,
    onTwoFingerDoubleTap: handleTwoFingerDoubleTap,
  })
  useEffect(() => {
    onInputRef.current = onInput
  }, [onInput])
  useEffect(() => {
    onResizeRef.current = onResize
  }, [onResize])
  useEffect(() => {
    attachExclusiveRef.current = attachExclusive
  }, [attachExclusive])
  useEffect(() => {
    onReadyRef.current = onReady
  }, [onReady])
  useEffect(() => {
    sessionNameRef.current = sessionName
  }, [sessionName])
  useEffect(() => {
    preferencesRef.current = preferences
  }, [preferences])
  useEffect(() => {
    subscribeOutputRef.current = subscribeOutput || subscribeWebSocketOutput
  }, [subscribeOutput, subscribeWebSocketOutput])
  useEffect(() => {
    activeHostIdRef.current = activeHostId
  }, [activeHostId])
  useEffect(() => {
    resubscribeOutputRef.current()
  }, [activeHostId, sessionName, subscribeOutput, subscribeWebSocketOutput])
  useEffect(() => {
    paneCwdRef.current = ''
    // 切换 session 不清屏：定格旧画面 + 攒流，新 session 首帧写完后才揭开，
    // 避免"黑屏→逐行重绘"以及 xterm 大写入跨帧解析造成的渐进刷新
    beginSessionSwitchRef.current()
  }, [activeHostId, sessionName])
  useEffect(() => {
    sendRef.current = send
  }, [send])
  useEffect(() => {
    updatePreferencesRef.current = updatePreferences
  }, [updatePreferences])
  useEffect(() => {
    tRef.current = t
  }, [t])
  useEffect(() => {
    const terminal = terminalInstance.current
    if (!terminal) return
    const style = getComputedStyle(document.documentElement)
    const getVar = (name: string) => style.getPropertyValue(name).trim()
    terminal.options.theme = {
      background: `rgb(${getVar('--bg-1')})`,
      foreground: `rgb(${getVar('--text-1')})`,
      cursor: `rgb(${getVar('--accent')})`,
      selectionBackground: `rgb(${getVar('--accent')} / 0.2)`,
    }
  }, [preferences.theme])
  useEffect(() => {
    const terminal = terminalInstance.current
    if (!terminal) return
    let cancelled = false
    void (async () => {
      await ensureAppFontLoaded(preferences.fontFamily, preferences.fontSize)
      if (cancelled || !terminalInstance.current) return
      const active = terminalInstance.current
      active.options.fontSize = preferences.fontSize
      active.options.fontFamily = preferences.fontFamily
      try {
        active.clearTextureAtlas?.()
      } catch {}
      try {
        active._core?._renderService?.clear?.()
      } catch {}
      try {
        active.refresh(0, Math.max(0, active.rows - 1))
      } catch {}
      scheduleLayoutRef.current(0, true, true)
    })()
    return () => {
      cancelled = true
    }
  }, [preferences.fontSize, preferences.fontFamily])
  useEffect(() => {
    if (!preferencesReady) return
    if (!terminalRef.current) return
    const runtime = createTerminalRuntime({
      container: terminalRef.current,
      isMobile: isMobileDevice,
      terminalInstance,
      onInputRef,
      onResizeRef,
      attachExclusiveRef,
      onReadyRef,
      sessionNameRef,
      preferencesRef,
      resubscribeOutputRef,
      lastSizeRef,
      sharedSessionSizeRef,
      controlCarryRef,
      scheduleLayoutRef,
      activeHostIdRef,
      tRef,
      afterTerminalWriteRef,
      subscribeOutputRef,
      sendRef,
      resolvePaneAtPointRef,
      paneResizeGuide: paneResizeGuideRef.current,
      resizeMaskElement: resizeMaskRef.current,
      switchVeilElement: switchVeilRef.current,
      resizeMaskApiRef,
      queryClient,
      pushToast,
      setActivePane,
      updateTerminalPerf,
      getTerminalPerf: () => useConsoleStore.getState().terminalPerf || DEFAULT_TERMINAL_PERF,
      selectionSync,
      pasteBridge,
      dropState,
      touchScroll,
      pinch: {
        handleTouchStart: handlePinchTouchStart,
        handleTouchMove: handlePinchTouchMove,
        handleTouchEnd: handlePinchTouchEnd,
        handleTouchCancel: handlePinchTouchCancel,
        handleDesktopPinch,
      },
      syncPaneCwd,
      ensureFileRoots,
      ensureAppFontLoaded,
      focusKeyboard,
      updateGithubDeviceLogin,
      pushTerminalOutput,
      disposeTerminalOutput,
      afterOutputWrites: afterTerminalOutputWrites,
      beginSessionSwitchRef,
    })
    return () => runtime.dispose()
  }, [
    afterTerminalOutputWrites,
    disposeTerminalOutput,
    ensureFileRoots,
    handleDesktopPinch,
    handlePinchTouchCancel,
    handlePinchTouchEnd,
    handlePinchTouchMove,
    handlePinchTouchStart,
    openUploadDialog,
    preferencesReady,
    pushToast,
    pushTerminalOutput,
    queryClient,
    selectionSync,
    setActivePane,
    syncPaneCwd,
    touchScroll,
    updateGithubDeviceLogin,
    updateTerminalPerf,
  ])
  return (
    <div
      ref={terminalRef}
      data-terminal
      tabIndex={0}
      className="h-full w-full min-h-0 overflow-hidden relative bg-bg-1"
      style={{
        ['--terminal-padding' as any]: `${preferences.terminalPadding}px`,
        ['--terminal-padding-bottom' as any]: `${preferences.terminalPadding}px`,
        touchAction: isMobileDevice ? 'none' : 'auto',
      }}
      onContextMenu={(e) => {
        if (!isMobileDevice) return
        e.preventDefault()
        e.stopPropagation()
      }}
      onMouseDown={() => {
        if (!isMobileDevice && !document.body.classList.contains('ime-composing')) terminalInstance.current?.focus?.()
      }}
      onFocus={() => {
        if (!isMobileDevice && !document.body.classList.contains('ime-composing')) terminalInstance.current?.focus?.()
      }}
      onTouchEnd={(e) => {
        if (isMobileDevice && !touchMovedRef.current) {
          e.preventDefault()
          const touch = e.changedTouches[0]
          const tap = lastTapRef.current || (touch ? { x: touch.clientX, y: touch.clientY } : null)
          if (tap) dispatchTerminalTap(tap.x, tap.y)
          lastTapRef.current = null
          focusKeyboard()
        } else if (!isMobileDevice) {
          terminalRef.current?.focus()
        }
        touchMovedRef.current = false
      }}
    >
      <div
        ref={resizeMaskRef}
        data-testid="terminal-resize-mask"
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-10 hidden overflow-hidden bg-bg-1"
        style={{ display: resizeMaskApiRef.current?.isPending() ? 'block' : undefined }}
      />
      <div
        ref={switchVeilRef}
        data-testid="terminal-switch-veil"
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-10 hidden overflow-hidden bg-bg-1"
      />
      <div
        ref={paneResizeGuideRef}
        data-testid="pane-resize-guide"
        className="pointer-events-none absolute z-20 hidden bg-accent shadow-[0_0_6px_var(--accent)]"
      />
      {dropState.isDropActive && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-apple border border-dashed border-accent bg-bg-0/70 text-sm text-accent shadow-[var(--glow)]">
          {t('terminal.dropUpload')}
        </div>
      )}
      {githubDeviceLogin && (
        <div
          data-testid="github-device-login-card"
          className="absolute inset-x-3 bottom-3 z-20 ml-auto w-auto max-w-sm rounded-apple border border-accent/30 bg-bg-0/92 p-3 backdrop-blur"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onTouchEnd={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-text-1">{t('githubAuth.title')}</div>
              <div className="mt-1 text-xs leading-5 text-text-3">{t('githubAuth.desc')}</div>
            </div>
            <Chip
              tone="danger"
              className="shrink-0"
              aria-label={t('githubAuth.dismiss')}
              onClick={dismissGithubDeviceLogin}
            >
              ✕
            </Chip>
          </div>
          <div className="mt-3 rounded-apple border border-[var(--line)] bg-bg-1 px-3 py-2">
            <div className="text-caption uppercase tracking-[0.24em] text-text-3">{t('githubAuth.code')}</div>
            <div className="mt-1 font-mono text-base tracking-[0.22em] text-accent">{githubDeviceLogin.code}</div>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              data-testid="github-device-login-open"
              onClick={openGithubDeviceLogin}
              className="flex-1 rounded-apple bg-accent px-3 py-2 text-sm font-medium text-bg-0 transition-transform active:scale-[0.98]"
            >
              {t('githubAuth.open')}
            </button>
            <button
              type="button"
              data-testid="github-device-login-copy"
              onClick={() => void copyGithubDeviceLogin()}
              className="flex-1 rounded-apple border border-[var(--line)] bg-bg-1 px-3 py-2 text-sm text-text-2 transition-transform active:scale-[0.98]"
            >
              {t('githubAuth.copy')}
            </button>
          </div>
        </div>
      )}
      {isMobileDevice && (
        <textarea
          ref={textareaRef}
          className="mobile-kb-input"
          rows={1}
          inputMode="text"
          enterKeyHint="enter"
          autoComplete="new-password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          tabIndex={-1}
          aria-label="Terminal input"
          style={{
            position: 'fixed',
            left: '50%',
            bottom: 'calc(var(--mobile-keyboard-inset, 0px) + env(safe-area-inset-bottom, 0px) + 10px)',
            width: 1,
            height: 1,
            padding: 0,
            border: 0,
            opacity: 0.01,
            background: 'transparent',
            color: 'transparent',
            pointerEvents: 'none',
            zIndex: 8,
            transform: 'translateX(-50%)',
          }}
        />
      )}
    </div>
  )
}
