'use client'
import { useEffect, useRef, useCallback, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import { usePreferences, ensureAppFontLoaded } from '@/hooks/usePreferences'
import { useMobileKeyboard } from '@/hooks/useMobileKeyboard'
import { useWebSocket } from '@/hooks/useWebSocket'
import { DELETE_NEXT_CHAR_SEQUENCE, DELETE_NEXT_WORD_SEQUENCE, DELETE_PREV_WORD_SEQUENCE, UNIX_WORD_RUBOUT_SEQUENCE } from '@/lib/terminal-keys'
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
import { recordMobileDiagnostic } from '@/lib/mobile-diagnostics'
import { recordImeDiagnostic } from '@/lib/ime-diagnostics'
import { useTerminalOutputScheduler } from '@/hooks/useTerminalOutputScheduler'
import { useTerminalPinch } from '@/hooks/useTerminalPinch'
import { buildSessionId } from '@/lib/session-id'
import { writeClipboardText } from '@/lib/clipboard-text'
import { createTerminalPaneInteractions } from '@/lib/terminal-pane-interactions'
import { createTerminalPaneResizeController } from '@/lib/terminal-pane-resize'
import { createTerminalClipboardIme } from '@/lib/terminal-clipboard-ime'
import { createTerminalCore } from '@/lib/terminal-core'
import { openFileInEditor } from '@/lib/editor-open'
import { Chip } from './Chip'
import type { FileDocumentHandle, FileRoot } from '@/types'

const SCROLLBACK_LIMIT = 600
const DELETE_WORD_REPEAT_DELAY = 420
const DELETE_WORD_REPEAT_SECOND_DELAY = 109
const DELETE_WORD_REPEAT_THIRD_DELAY = 78
const DELETE_WORD_REPEAT_FOURTH_DELAY = 56
const DELETE_WORD_REPEAT_MIN_DELAY = 30
const DEFAULT_TERMINAL_PERF = { attachLatency: 0, outputBytes: 0, outputEvents: 0, outputBacklog: 0, layoutFitCount: 0, lastOutputAt: '' }
const TERMINAL_REPAINT_DELAYS = [0, 16, 48, 120, 260]
const MOBILE_TERMINAL_REPAINT_DELAYS = [96]
const TERMINAL_RECOVERY_REPAINT_DELAYS = [0, 16, 64, 180]
const MOBILE_TERMINAL_RECOVERY_REPAINT_DELAYS = [48, 160]
const MOBILE_TERMINAL_KEYBOARD_REPAINT_DELAYS = [0, 48, 160]
const LAYOUT_REPAINT_DELAYS = [0, 32]
const MOBILE_FIT_SIZE_TOLERANCE = 2
const RESIZE_MASK_FAILSAFE_MS = 900
const DEVICE_PIXEL_RATIO_TOLERANCE = 0.01
const GITHUB_DEVICE_LOGIN_URL = 'https://github.com/login/device'
let terminalResizePending = false
const ANSI_ESCAPE_REGEX = /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g
const TERMINAL_URL_REGEX = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~\[\]`()<>]/g
const TERMINAL_FILE_LINK_REGEX = /(^|[\s([{'"`])((?:\/|\.{1,2}\/|~\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*(?::\d+){0,2})(?=$|[\s)\]}'"`,;.!?，。；、])/g
type TerminalLineLink={kind:'url';text:string;start:number;end:number;url:string}|{kind:'file';text:string;start:number;end:number;pathText:string;line:number|null;column:number|null}
function normalizeTerminalText(value: string) {
  return value.replace(ANSI_ESCAPE_REGEX, '').replace(/\r/g, '\n')
}
function extractGithubDeviceLogin(text: string) {
  const codePattern = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/ig
  const urlPattern = /https:\/\/github\.com\/login\/device\b/ig
  let code = ''
  let url = ''
  let match: RegExpExecArray | null
  while ((match = codePattern.exec(text))) code = match[1]?.toUpperCase() || code
  if (!code) return null
  while ((match = urlPattern.exec(text))) url = match[0] || url
  return { code, url: url || GITHUB_DEVICE_LOGIN_URL }
}
function recordMobileDebug(event: string, data?: Record<string, unknown>) {
  recordMobileDiagnostic(event, data)
  if (typeof window === 'undefined' || !window.localStorage.getItem('tmuxgo-debug-mobile')) return
  const target = window as typeof window & { __tmuxgoMobileDebug?: { events: Array<Record<string, unknown>> } }
  const state = target.__tmuxgoMobileDebug || { events: [] }
  state.events.push({ event, at: Math.round(performance.now()), ...data })
  state.events = state.events.slice(-240)
  target.__tmuxgoMobileDebug = state
}
function recordImeDebug(event: string, data?: Record<string, unknown>) {
  recordImeDiagnostic('terminal-pane', event, data)
}

interface TerminalPaneProps {
  sessionName?: string
  onInput?: (data: string) => void
  onResize?: (cols: number, rows: number) => void
  attachExclusive?: boolean
  onReady?: () => void
  subscribeOutput?: (hostId: string, sessionName: string, listener: (message: { data: string; sessionName?: string | null; hostId?: string | null; resync?: boolean }) => void) => () => void
  send?: (data: any) => boolean
  onSwipeLeft?: () => void
  onSwipeRight?: () => void
}

function isApplePlatform() {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const platform = nav.userAgentData?.platform || nav.platform || ''
  return /Mac|iPhone|iPad|iPod/.test(platform)
}

function isPasteShortcut(e: KeyboardEvent) {
  if (e.altKey || e.key.toLowerCase() !== 'v') return false
  if (e.ctrlKey && !e.metaKey) return true
  if (e.metaKey && !e.ctrlKey && isApplePlatform()) return true
  return false
}
function isImeKeyEvent(e: KeyboardEvent) {
  return e.isComposing || e.key === 'Process' || e.keyCode === 229 || e.which === 229
}
function stripWrappedQuotes(value: string) {
  return value.replace(/^[\s'"([{<]+/, '').replace(/[\s'")\]}>.,;!?，。；、]+$/, '')
}
function normalizeAbsolutePath(value: string) {
  const raw = stripWrappedQuotes(value.trim())
  if (!raw) return ''
  const stack: string[] = []
  if (!raw.startsWith('/')) return ''
  const base = raw
  for (const part of base.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return `/${stack.join('/')}`
}
function getRootRelativePath(rootPath: string, absolutePath: string) {
  const normalizedRoot = rootPath === '/' ? '/' : rootPath.replace(/\/+$/, '')
  const normalizedPath = absolutePath.replace(/\/+$/, '')
  if (normalizedRoot !== '/' && normalizedPath !== normalizedRoot && !normalizedPath.startsWith(`${normalizedRoot}/`)) return null
  return normalizedRoot === '/' ? normalizedPath.replace(/^\/+/, '') : normalizedPath.slice(normalizedRoot.length).replace(/^\/+/, '')
}
function chooseFileRoot(roots: FileRoot[], absolutePath: string) {
  let match: FileRoot | null = null
  let matchLength = -1
  for (const root of roots) {
    const relativePath = getRootRelativePath(root.path, absolutePath)
    if (relativePath == null) continue
    if (root.path.length > matchLength) {
      match = root
      matchLength = root.path.length
    }
  }
  return match
}
function looksLikeFilePath(value: string) {
  if (!value || /^https?:\/\//i.test(value)) return false
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value.startsWith('~/')) return true
  if (value.includes('/')) return true
  if (/^(Dockerfile|Makefile|README(?:\.[A-Za-z0-9_-]+)?|LICENSE(?:\.[A-Za-z0-9_-]+)?|\.env(?:\.[A-Za-z0-9_-]+)?)$/.test(value)) return true
  return /^[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]{1,12}$/.test(value)
}
function resolveHomePath(path: string, cwd: string, roots: FileRoot[]) {
  if (!path.startsWith('~/')) return ''
  const cwdHome = cwd.match(/^((?:\/home|\/Users)\/[^/]+)(?:\/|$)/)?.[1] || ''
  if (cwdHome) return normalizeAbsolutePath(`${cwdHome}/${path.slice(2)}`)
  const homeRoot = roots.find((item) => /home/i.test(item.label)) || roots.find((item) => /^(?:\/home|\/Users)\/[^/]+$/.test(item.path)) || null
  if (!homeRoot) return ''
  return normalizeAbsolutePath(`${homeRoot.path}/${path.slice(2)}`)
}
function resolveCandidateAbsolutePath(path: string, cwd: string, roots: FileRoot[]) {
  if (path.startsWith('/')) return normalizeAbsolutePath(path)
  if (path.startsWith('~/')) return resolveHomePath(path, cwd, roots)
  if (!cwd) return ''
  return normalizeAbsolutePath(`${cwd.replace(/\/+$/, '')}/${path}`)
}
function openUrlInNewWindow(url: string, pushToast: (toast: { type: 'success' | 'error' | 'info'; message: string; durationMs?: number }) => void, t: ReturnType<typeof useTranslation>['t']) {
  const opened = window.open(url, '_blank', 'noopener,noreferrer')
  if (opened) return true
  pushToast({ type: 'error', message: t('terminal.linkOpenBlocked') })
  return false
}
function parseTerminalFileLink(text: string, start: number, end: number): Extract<TerminalLineLink,{kind:'file'}> | null {
  const suffixMatch = text.match(/^(.*?)(?::(\d+))?(?::(\d+))?$/)
  const pathText = stripWrappedQuotes(suffixMatch?.[1] || text)
  if (!pathText || !looksLikeFilePath(pathText)) return null
  return {
    kind: 'file',
    text,
    start,
    end,
    pathText,
    line: suffixMatch?.[2] ? Number(suffixMatch[2]) : null,
    column: suffixMatch?.[3] ? Number(suffixMatch[3]) : null,
  }
}
function collectTerminalLineLinks(line: string) {
  if (!line) return [] as TerminalLineLink[]
  const urlLinks: TerminalLineLink[] = []
  const urlMatches = Array.from(line.matchAll(new RegExp(TERMINAL_URL_REGEX.source, 'g')))
  for (const match of urlMatches) {
    const text = match[0] || ''
    const start = match.index ?? -1
    if (!text || start < 0) continue
    urlLinks.push({ kind: 'url', text, start, end: start + text.length, url: text })
  }
  const fileLinks: TerminalLineLink[] = []
  const fileMatches = Array.from(line.matchAll(new RegExp(TERMINAL_FILE_LINK_REGEX.source, 'g')))
  for (const match of fileMatches) {
    const text = match[2] || ''
    const prefix = match[1] || ''
    const start = (match.index ?? -1) + prefix.length
    if (!text || start < 0) continue
    const end = start + text.length
    if (urlLinks.some((item) => start < item.end && end > item.start)) continue
    const parsed = parseTerminalFileLink(text, start, end)
    if (parsed) fileLinks.push(parsed)
  }
  return [...urlLinks, ...fileLinks].sort((a, b) => a.start - b.start || (a.kind === 'url' ? -1 : 1))
}
function resolveCandidateAbsolutePaths(path: string, cwd: string, roots: FileRoot[]) {
  const candidates: string[] = []
  const push = (value: string) => {
    const normalized = normalizeAbsolutePath(value)
    if (normalized) candidates.push(normalized)
  }
  if (path.startsWith('/')) push(path)
  else if (path.startsWith('~/')) {
    const homePath = resolveHomePath(path, cwd, roots)
    if (homePath) push(homePath)
  } else if (path.startsWith('./') || path.startsWith('../')) {
    if (cwd) push(`${cwd.replace(/\/+$/, '')}/${path}`)
    for (const root of roots) push(`${root.path.replace(/\/+$/, '')}/${path}`)
  } else if (path.includes('/')) {
    for (const root of roots) push(`${root.path.replace(/\/+$/, '')}/${path}`)
    if (cwd) push(`${cwd.replace(/\/+$/, '')}/${path}`)
  } else {
    if (cwd) push(`${cwd.replace(/\/+$/, '')}/${path}`)
    for (const root of roots) push(`${root.path.replace(/\/+$/, '')}/${path}`)
  }
  return Array.from(new Set(candidates))
}

export function TerminalPane({ sessionName, onInput, onResize, attachExclusive = false, onReady, subscribeOutput, send: sendProp, onSwipeLeft, onSwipeRight }: TerminalPaneProps) {
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
  const touchMovedRef = useRef(false)
  const terminalInstance = useRef<any>(null)
  const [githubDeviceLogin, setGithubDeviceLogin] = useState<{ code: string; url: string } | null>(null)
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
  const activeHostIdRef = useRef(activeHostId)
  const sessionSnapshotRef = useRef<any | null>(null)
  const sessionSnapshotRequestRef = useRef<{ key: string; promise: Promise<any> } | null>(null)
  const sessionSnapshotLoadedRef = useRef({ key: '', at: 0 })
  const updatePreferencesRef = useRef(updatePreferences)
  const tRef = useRef(t)
  const afterTerminalWriteRef = useRef<() => void>(() => {})
  const githubDeviceLoginRef = useRef<{ code: string; url: string } | null>(null)
  const githubDeviceLoginDismissedRef = useRef('')
  const githubDeviceLoginBufferRef = useRef('')
  const githubAuthLoggedInRef = useRef<boolean | null>(null)
  const fileRootsRef = useRef<FileRoot[] | null>(null)
  const fileRootsHostIdRef = useRef('')
  const paneCwdRef = useRef<string>('')
  const setGithubDeviceLoginState = useCallback((next: { code: string; url: string } | null) => {
    githubDeviceLoginRef.current = next
    setGithubDeviceLogin(next)
  }, [])
  const dismissGithubDeviceLogin = useCallback(() => {
    if (githubDeviceLoginRef.current?.code) githubDeviceLoginDismissedRef.current = githubDeviceLoginRef.current.code
    setGithubDeviceLoginState(null)
  }, [setGithubDeviceLoginState])
  const openGithubDeviceLogin = useCallback(() => {
    const url = githubDeviceLoginRef.current?.url || GITHUB_DEVICE_LOGIN_URL
    openUrlInNewWindow(url, pushToast, t)
  }, [pushToast, t])
  const copyGithubDeviceLogin = useCallback(async () => {
    const code = githubDeviceLoginRef.current?.code
    if (!code) return
    const result = await writeClipboardText(code)
    if (!result.copied) {
      pushToast({ type: 'error', message: t('clipboard.copyFailed') })
      return
    }
    pushToast({ type: result.unavailable ? 'info' : 'success', message: result.unavailable ? t('githubAuth.copiedInApp') : t('githubAuth.copied') })
  }, [pushToast, t])
  const syncGithubDeviceLogin = useCallback(() => {
    if (githubAuthLoggedInRef.current !== false) {
      if (githubAuthLoggedInRef.current === true && githubDeviceLoginRef.current) setGithubDeviceLoginState(null)
      return
    }
    const detected = extractGithubDeviceLogin(githubDeviceLoginBufferRef.current)
    if (!detected) return
    if (detected.code === githubDeviceLoginDismissedRef.current && githubDeviceLoginRef.current?.code !== detected.code) return
    const current = githubDeviceLoginRef.current
    if (current?.code === detected.code && current.url === detected.url) return
    githubDeviceLoginDismissedRef.current = ''
    setGithubDeviceLoginState(detected)
  }, [setGithubDeviceLoginState])
  const updateGithubDeviceLogin = useCallback((raw: string) => {
    const normalized = normalizeTerminalText(raw)
    if (!normalized) return
    githubDeviceLoginBufferRef.current = (githubDeviceLoginBufferRef.current + normalized).slice(-4096)
    syncGithubDeviceLogin()
  }, [syncGithubDeviceLogin])
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
    const target = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) as HTMLElement | null : null
    const terminalTarget = target?.closest('.xterm-screen') || target?.closest('.xterm') || container.querySelector('.xterm-screen') || container.querySelector('.xterm')
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
  const handlePasteFiles = useCallback((files: File[]) => openUploadDialog({ files, insertPaths: true, temporary: true }), [openUploadDialog])
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
  const handleTerminalMetrics = useCallback((raw: string, outputLength: number, backlogLength: number) => {
    recordTerminalOutput(useConsoleStore.getState().terminalPerf || DEFAULT_TERMINAL_PERF, raw, outputLength, backlogLength)
  }, [recordTerminalOutput])
  const handleTerminalBackpressure = useCallback((level: 'high' | 'normal', backlog: number) => {
    updateTerminalPerf({ outputBacklog: backlog })
    sendRef.current({ type: 'stream_backpressure', level, mobile: isMobileDevice })
  }, [isMobileDevice, updateTerminalPerf])
  const { push: pushTerminalOutput, dispose: disposeTerminalOutput } = useTerminalOutputScheduler({
    write: writeTerminalOutput,
    onWrite: handleTerminalWriteComplete,
    onMetrics: handleTerminalMetrics,
    onBackpressure: handleTerminalBackpressure,
  })
  const handleTouchScroll = useCallback((lines: number) => send({ type: 'pane_scroll', hostId: activeHostIdRef.current || 'local', sessionName: sessionNameRef.current, lines }), [send])
  const handleTouchTap = useCallback((x: number, y: number) => {
    lastTapRef.current = { x, y }
  }, [])
  const handleTouchMovedChange = useCallback((moved: boolean) => {
    touchMovedRef.current = moved
  }, [])
  const { handleTouchStart:handlePinchTouchStart,handleTouchMove:handlePinchTouchMove,handleTouchEnd:handlePinchTouchEnd,handleTouchCancel:handlePinchTouchCancel,handleDesktopPinch }=useTerminalPinch({isMobile:isMobileDevice,terminalRef:terminalInstance,preferencesRef,updatePreferencesRef,scheduleLayoutRef,touchMovedRef})
  const zoomPaneById = useCallback((paneId: string | null) => {
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
  }, [discardOptimisticWindowZoom, optimisticallyToggleWindowZoom, pushToast, refreshSnapshot, setActivePane])
  const handleTwoFingerDoubleTap = useCallback((x: number, y: number) => {
    const paneId = resolvePaneAtPointRef.current(x, y) || useConsoleStore.getState().activePaneId
    zoomPaneById(paneId)
  }, [zoomPaneById])
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
    sessionSnapshotRef.current = null
    sessionSnapshotRequestRef.current = null
    sessionSnapshotLoadedRef.current = { key: '', at: 0 }
    const terminal = terminalInstance.current
    if (terminal) {
      try { terminal.clear?.() } catch {}
      try { terminal.refresh?.(0, Math.max(0, (terminal.rows || 1) - 1)) } catch {}
    }
    terminalResizePending = false
    const staleMask = resizeMaskRef.current
    if (staleMask) {
      staleMask.style.display = 'none'
      staleMask.replaceChildren()
    }
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
    githubDeviceLoginBufferRef.current = ''
    githubDeviceLoginDismissedRef.current = ''
    githubAuthLoggedInRef.current = null
    setGithubDeviceLoginState(null)
  }, [activeHostId, sessionName, setGithubDeviceLoginState])
  useEffect(() => {
    let disposed = false
    const hostId = activeHostId || 'local'
    githubAuthLoggedInRef.current = null
    void api.hosts.githubAuthStatus(hostId).then((status) => {
      if (disposed) return
      githubAuthLoggedInRef.current = status.ok ? status.loggedIn : null
      syncGithubDeviceLogin()
    }).catch(() => {
      if (disposed) return
      githubAuthLoggedInRef.current = null
      syncGithubDeviceLogin()
    })
    return () => {
      disposed = true
    }
  }, [activeHostId, syncGithubDeviceLogin])

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
    return () => { cancelled = true }
  }, [preferences.fontSize, preferences.fontFamily])

  useEffect(() => {
    if (!preferencesReady) return
    if (!terminalRef.current) return
    const container = terminalRef.current
    let terminal: any = null
    let resizeObserver: ResizeObserver | null = null
    let disposables: any[] = []
    let layoutTimeout: ReturnType<typeof setTimeout> | null = null
    let fontLayoutTimer: ReturnType<typeof setTimeout> | null = null
    let resizeRevealFrame: number | null = null
    let resizeStabilityFrame: number | null = null
    let resizeMaskFailsafeTimer: ReturnType<typeof setTimeout> | null = null
    let resizeMaskGeneration = 0
    let resizeStableFrames = 0
    let resizeObservedSize = { width: 0, height: 0 }
    let sharedLayoutFrame: number | null = null
    let layoutFrame: number | null = null
    let repaintFrame: number | null = null
    let repaintTimers: ReturnType<typeof setTimeout>[] = []
    let disposed = false
    let readyNotified = false
    let sharedPanX = 0
    let sharedMaxPanX = 0
    let lastContainerSize = { width: 0, height: 0 }
    let lastFitSize = { width: 0, height: 0 }
    let pendingLayoutForce = false
    let pendingLayoutResetFont = false
    let layoutRetryCount = 0
    let initialFitPending = false
    let lastRefreshAt = 0
    let lastDevicePixelRatio = window.devicePixelRatio || 1
    let deleteWordRepeatTimer: ReturnType<typeof setTimeout> | null = null
    let deleteWordRepeatActive = false
    let pointerSyncActive = false
    let helperTextareaComposing = false
    let helperTextarea: HTMLTextAreaElement | null | undefined = null
    let lastKeyboardOpen = document.body.classList.contains('keyboard-open')
    let mobileKeyboardTransition = false
    let writeBuffer = ''
    let writePending = false
    let pendingPostImeSyncTimer: ReturnType<typeof setTimeout> | null = null
    let attachEventCount = 0
    let outputSinceLastAttach = false

    const notifyReady = () => {
      if (disposed || readyNotified) return
      readyNotified = true
      onReadyRef.current?.()
    }
    const clearTerminalBrowserSelection = () => {
      const selection = window.getSelection?.()
      if (!selection) return
      const anchorNode = selection.anchorNode
      const focusNode = selection.focusNode
      if (anchorNode && container.contains(anchorNode) || focusNode && container.contains(focusNode)) selection.removeAllRanges()
    }
    const isDesktopImeComposing = () => helperTextareaComposing || document.body.classList.contains('ime-composing')
    const syncHelperTextareaGeometry = () => {
      const input = helperTextarea || container.querySelector('.xterm-helper-textarea, textarea')
      if (!(input instanceof HTMLTextAreaElement) || !terminal) return
      if (isDesktopImeComposing()) return
      const activeBuffer = terminal.buffer?.active
      const cursorXRaw = Number(activeBuffer?.cursorX)
      const cursorYRaw = Number(activeBuffer?.cursorY)
      const cellWidth = Number(terminal._core?._renderService?.dimensions?.css?.cell?.width)
      const cellHeight = Number(terminal._core?._renderService?.dimensions?.css?.cell?.height)
      if (!Number.isFinite(cellWidth) || !Number.isFinite(cellHeight) || cellWidth <= 0 || cellHeight <= 0) return
      const maxX = Math.max(0, (Number(terminal.cols) || 1) - 1)
      const maxY = Math.max(0, (Number(terminal.rows) || 1) - 1)
      const cursorX = Math.max(0, Math.min(maxX, Number.isFinite(cursorXRaw) ? cursorXRaw : 0))
      const cursorY = Math.max(0, Math.min(maxY, Number.isFinite(cursorYRaw) ? cursorYRaw : 0))
      let charWidth = 1
      try {
        const line = activeBuffer?.getLine?.(cursorY)
        const width = Number(line?.getWidth?.(cursorX))
        if (Number.isFinite(width) && width > 0) charWidth = width
      } catch {}
      input.style.left = `${cursorX * cellWidth}px`
      input.style.top = `${cursorY * cellHeight}px`
      input.style.width = `${cellWidth * charWidth}px`
      input.style.height = `${cellHeight}px`
      input.style.lineHeight = `${cellHeight}px`
      input.style.zIndex = '-5'
    }
    const focusTerminalInput = () => {
      recordImeDebug('focus-terminal-input', { mobile: isMobileDevice, composing: helperTextareaComposing })
      if (isMobileDevice) {
        cancelTmuxCopyMode()
        focusKeyboard()
        return
      }
      if (isDesktopImeComposing()) return
      const input = helperTextarea || container.querySelector('.xterm-helper-textarea, textarea')
      if (input instanceof HTMLTextAreaElement && document.activeElement === input) {
        syncHelperTextareaGeometry()
        clearTerminalBrowserSelection()
        return
      }
      terminal?.focus?.()
      if (input instanceof HTMLTextAreaElement) {
        if (document.activeElement !== input) input.focus({ preventScroll: true })
        syncHelperTextareaGeometry()
        requestAnimationFrame(syncHelperTextareaGeometry)
      }
      clearTerminalBrowserSelection()
      requestAnimationFrame(clearTerminalBrowserSelection)
    }
    const getSessionSnapshotKey = () => {
      const hostId = activeHostIdRef.current
      const currentSessionName = sessionNameRef.current
      if (!hostId || !currentSessionName) return null
      return ['session-snapshot', hostId, buildSessionId(hostId, currentSessionName)]
    }
    const readSessionSnapshot = () => {
      const key = getSessionSnapshotKey()
      const cached = key ? queryClient?.getQueryData?.(key) : null
      if (cached) sessionSnapshotRef.current = cached
      return sessionSnapshotRef.current
    }
    const loadSessionSnapshot = async (force = false) => {
      const key = getSessionSnapshotKey()
      const hostId = activeHostIdRef.current
      const currentSessionName = sessionNameRef.current
      if (!key || !hostId || !currentSessionName) return null
      const requestKey = `${hostId}:${currentSessionName}`
      if (!force && sessionSnapshotRef.current && sessionSnapshotLoadedRef.current.key === requestKey && Date.now() - sessionSnapshotLoadedRef.current.at < 1000) return sessionSnapshotRef.current
      if (!sessionSnapshotRequestRef.current || sessionSnapshotRequestRef.current.key !== requestKey) {
        const promise = api.snapshot.get(hostId, buildSessionId(hostId, currentSessionName)).finally(() => {
          if (sessionSnapshotRequestRef.current?.key === requestKey) sessionSnapshotRequestRef.current = null
        })
        sessionSnapshotRequestRef.current = { key: requestKey, promise }
      }
      const snapshot = await sessionSnapshotRequestRef.current.promise
      if (`${activeHostIdRef.current}:${sessionNameRef.current}` !== requestKey) return snapshot
      sessionSnapshotRef.current = snapshot
      sessionSnapshotLoadedRef.current = { key: requestKey, at: Date.now() }
      queryClient?.setQueryData(key, snapshot)
      return snapshot
    }
    const { getSelectionText, getMouseCell, getPaneIdByMouseCell, getPaneResizeTarget, getPaneIdAtPoint } = createTerminalPaneInteractions(() => terminal, container, readSessionSnapshot)
    resolvePaneAtPointRef.current = getPaneIdAtPoint
    const getBufferLineText = (lineIndex: number) => {
      const line = terminal?.buffer?.active?.getLine?.(lineIndex)
      if (!line) return ''
      try {
        return String(line.translateToString(true))
      } catch {
        return ''
      }
    }
    const isLinkOpenGesture = (event: MouseEvent) => event.button === 0 && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && !isMobileDevice
    const resolveTerminalFileLink = async (link: Extract<TerminalLineLink,{kind:'file'}>) => {
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
    const createTerminalFileLinks = (bufferLineNumber: number) => {
      const line = getBufferLineText(bufferLineNumber - 1)
      return collectTerminalLineLinks(line).filter((item): item is Extract<TerminalLineLink,{kind:'file'}> => item.kind === 'file').map((item) => ({
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
            return openFileInEditor(result.file, { t: tRef.current, pushToast, position: result.position, openPanel: true })
          })
        },
      }))
    }
    const showResizeMask = () => {
      if (resizeRevealFrame) cancelAnimationFrame(resizeRevealFrame)
      resizeRevealFrame = null
      if (resizeMaskFailsafeTimer) clearTimeout(resizeMaskFailsafeTimer)
      const generation = resizeMaskGeneration + 1
      resizeMaskFailsafeTimer = setTimeout(() => {
        resizeMaskFailsafeTimer = null
        recordMobileDebug('terminal-resize-mask-failsafe', { generation })
        revealResizeMask(generation)
      }, RESIZE_MASK_FAILSAFE_MS)
      resizeMaskGeneration = generation
      terminalResizePending = true
      const mask = resizeMaskRef.current
      if (mask && mask.style.display !== 'block') {
        mask.style.display = 'block'
        const screen = terminal?.element?.querySelector('.xterm-screen') as HTMLElement | null
        if (screen) {
          const snapshot = screen.cloneNode(true) as HTMLElement
          const screenRect = screen.getBoundingClientRect()
          const maskRect = mask.getBoundingClientRect()
          snapshot.style.setProperty('inset', 'auto', 'important')
          snapshot.style.setProperty('left', `${screenRect.left - maskRect.left}px`, 'important')
          snapshot.style.setProperty('top', `${screenRect.top - maskRect.top}px`, 'important')
          snapshot.style.setProperty('width', `${screenRect.width}px`, 'important')
          snapshot.style.setProperty('height', `${screenRect.height}px`, 'important')
          const sourceCanvases = Array.from(screen.querySelectorAll('canvas'))
          const snapshotCanvases = Array.from(snapshot.querySelectorAll('canvas'))
          sourceCanvases.forEach((source, index) => {
            try {
              snapshotCanvases[index]?.getContext('2d')?.drawImage(source, 0, 0)
            } catch {}
          })
          mask.replaceChildren(snapshot)
        }
      }
      return resizeMaskGeneration
    }
    const revealResizeMask = (generation = resizeMaskGeneration) => {
      if (generation !== resizeMaskGeneration) return
      if (resizeMaskFailsafeTimer) {
        clearTimeout(resizeMaskFailsafeTimer)
        resizeMaskFailsafeTimer = null
      }
      if (resizeRevealFrame) cancelAnimationFrame(resizeRevealFrame)
      let synchronous = true
      const frame = requestAnimationFrame(() => {
        resizeRevealFrame = null
        if (generation !== resizeMaskGeneration) return
        let nextSynchronous = true
        const nextFrame = requestAnimationFrame(() => {
          resizeRevealFrame = null
          if (generation !== resizeMaskGeneration) return
          terminalResizePending = false
          const mask = resizeMaskRef.current
          if (mask) {
            mask.style.display = 'none'
            mask.replaceChildren()
          }
          nextSynchronous = false
        })
        if (nextSynchronous) resizeRevealFrame = nextFrame
        synchronous = false
      })
      if (synchronous) resizeRevealFrame = frame
    }
    const isResizeMaskVisible = () => resizeMaskRef.current?.style.display === 'block'
    const paneResize = createTerminalPaneResizeController({
      container,
      guide: paneResizeGuideRef.current,
      getTerminal: () => terminal,
      getMouseCell,
      getPaneResizeTarget,
      resizePane: (paneId, size) => api.panes.resize(paneId, size),
      loadSessionSnapshot: () => loadSessionSnapshot(true),
      showResizeMask,
      revealResizeMask,
      clearSelection: () => terminal?.clearSelection?.(),
      clearCopySelectionTimer: selectionSync.clearCopySelectionTimer,
      clearPointerSync: () => { pointerSyncActive = false },
      dispatchLayoutChange: () => window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'tmux-pane-resize' } })),
    })
    const stopDeleteWordRepeat = () => {
      deleteWordRepeatActive = false
      if (deleteWordRepeatTimer) {
        clearTimeout(deleteWordRepeatTimer)
        deleteWordRepeatTimer = null
      }
    }
    const startDeleteWordRepeat = () => {
      stopDeleteWordRepeat()
      deleteWordRepeatActive = true
      let delay = DELETE_WORD_REPEAT_DELAY
      let repeatCount = 0
      const tick = () => {
        if (disposed || !deleteWordRepeatActive) return
        onInputRef.current?.(DELETE_PREV_WORD_SEQUENCE)
        repeatCount += 1
        delay = repeatCount === 1 ? DELETE_WORD_REPEAT_SECOND_DELAY : repeatCount === 2 ? DELETE_WORD_REPEAT_THIRD_DELAY : repeatCount === 3 ? DELETE_WORD_REPEAT_FOURTH_DELAY : DELETE_WORD_REPEAT_MIN_DELAY
        deleteWordRepeatTimer = setTimeout(tick, delay)
      }
      deleteWordRepeatTimer = setTimeout(tick, delay)
    }
    const syncActivePane = async () => {
      const hostId = activeHostIdRef.current
      const currentSessionName = sessionNameRef.current
      if (!hostId || !currentSessionName) return
      try {
        const snapshot = await loadSessionSnapshot(true)
        if (snapshot?.activePaneId) setActivePane(snapshot.activePaneId)
      } catch {}
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
      sendRef.current({ type: 'copy_mode_cancel', hostId: activeHostIdRef.current || 'local', sessionName: currentSessionName })
    }
    const isTerminalScrolledBack = () => {
      const activeBuffer = terminal?.buffer?.active
      const baseY = Number(activeBuffer?.baseY)
      const viewportY = Number(activeBuffer?.viewportY)
      if (Number.isFinite(baseY) && Number.isFinite(viewportY)) return viewportY < baseY - 1
      const viewport = terminal?.element?.querySelector('.xterm-viewport') as HTMLElement | null
      if (!viewport) return false
      return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 2
    }
    const scrollTerminalToBottom = () => {
      if (!terminal || disposed) return
      try {
        terminal.scrollToBottom?.()
      } catch {}
      const viewport = terminal?.element?.querySelector('.xterm-viewport') as HTMLElement | null
      if (viewport) viewport.scrollTop = viewport.scrollHeight
    }
    const refreshTerminalRows = (force = false) => {
      if (!terminal || disposed) return
      try {
        const now = performance.now()
        if (!force && isMobileDevice && now - lastRefreshAt < 120) return
        lastRefreshAt = now
        recordMobileDebug('terminal-refresh', { rows: terminal.rows })
        terminal.refresh(0, Math.max(0, terminal.rows - 1))
      } catch {}
    }
    const repaintTerminalRenderer = (forceRefresh = false, stickToBottom = false) => {
      if (!terminal || disposed) return
      try {
        if (attachExclusiveRef.current) syncExclusiveViewport()
        else syncSharedViewport()
        if (stickToBottom) scrollTerminalToBottom()
        refreshTerminalRows(forceRefresh)
      } catch {}
    }
    const clearTerminalRepaint = () => {
      if (repaintFrame) {
        cancelAnimationFrame(repaintFrame)
        repaintFrame = null
      }
      for (const timer of repaintTimers) clearTimeout(timer)
      repaintTimers = []
    }
    const scheduleTerminalRepaint = (delays = TERMINAL_REPAINT_DELAYS, serverRedraw = false, stickToBottom = false, forceRefresh = false) => {
      if (disposed) return
      clearTerminalRepaint()
      let redrawRequested = false
      const requestRedrawOnce = () => {
        if (!serverRedraw || redrawRequested) return
        redrawRequested = true
        requestServerRedraw()
      }
      for (const delay of delays) {
        if (delay <= 0) {
          repaintFrame = requestAnimationFrame(() => {
            repaintFrame = null
            repaintTerminalRenderer(forceRefresh, stickToBottom)
            requestRedrawOnce()
          })
          continue
        }
        const timer = setTimeout(() => {
          repaintTimers = repaintTimers.filter((item) => item !== timer)
          repaintTerminalRenderer(forceRefresh, stickToBottom)
          requestRedrawOnce()
        }, delay)
        repaintTimers.push(timer)
      }
    }

    const getCanvasSize = () => {
      const canvas = terminal?._core?._renderService?.dimensions?.css?.canvas
      if (!canvas?.width || !canvas?.height) return null
      return { width: canvas.width, height: canvas.height }
    }
    const getScreenSize = () => {
      const screen = terminal?.element?.querySelector('.xterm-screen') as HTMLElement | null
      if (!screen) return null
      const rect = screen.getBoundingClientRect()
      if (!rect.width || !rect.height) return null
      return { width: rect.width, height: rect.height }
    }
    const getTerminalPadding = () => {
      if (!container) {
        const padding = preferencesRef.current.terminalPadding
        return { left: padding, right: padding, top: padding, bottom: isMobileDevice ? 0 : padding }
      }
      const style = window.getComputedStyle(container)
      return {
        left: parseInt(style.getPropertyValue('padding-left')) || 0,
        right: parseInt(style.getPropertyValue('padding-right')) || 0,
        top: parseInt(style.getPropertyValue('padding-top')) || 0,
        bottom: parseInt(style.getPropertyValue('padding-bottom')) || 0,
      }
    }
    const getFitDimensions = () => {
      if (!terminal?.element?.parentElement) return null
      const dims = terminal?._core?._renderService?.dimensions?.css
      const cellWidth = dims?.cell?.width
      const cellHeight = dims?.cell?.height
      if (!cellWidth || !cellHeight) return null
      const fontSize = Number(terminal.options.fontSize) || preferencesRef.current.fontSize
      if (cellWidth < Math.max(4, fontSize * 0.45) || cellHeight < Math.max(8, fontSize * 0.75)) return null
      const parentElement = terminal.element.parentElement
      const padding = getTerminalPadding()
      const parentHeight = Math.max(0, parentElement.clientHeight)
      const parentWidth = Math.max(0, parentElement.clientWidth)
      const paddingY = padding.top + padding.bottom
      const paddingX = padding.left + padding.right
      const availableHeight = Math.max(0, parentHeight - paddingY)
      const availableWidth = Math.max(0, parentWidth - paddingX)
      if (availableWidth < 8 || availableHeight < 8) return null
      const cols = Math.max(2, Math.floor(availableWidth / cellWidth))
      const rows = Math.max(1, Math.floor(availableHeight / cellHeight))
      return { cols, rows }
    }

    const getAvailableSize = () => {
      const padding = getTerminalPadding()
      return {
        width: Math.max(1, container.clientWidth - padding.left - padding.right),
        height: Math.max(1, container.clientHeight - padding.top - padding.bottom),
      }
    }
    const applyTerminalOptions = (fontSize?: number) => {
      if (!terminal || disposed) return
      terminal.options.fontFamily = preferencesRef.current.fontFamily
      terminal.options.fontWeight = '400'
      terminal.options.fontWeightBold = '700'
      terminal.options.cursorBlink = preferencesRef.current.cursorBlink
      const nextFontSize = (fontSize ?? Number(terminal.options.fontSize)) || preferencesRef.current.fontSize
      terminal.options.fontSize = nextFontSize
      terminal.options.letterSpacing = 0
      terminal.options.lineHeight = 1
      terminal.options.minimumContrastRatio = 4.5
      terminal.options.customGlyphs = true
    }
    const getRendererElements = () => {
      const element = terminal?.element as HTMLElement | null
      if (!element) return null
      const screen = element.querySelector('.xterm-screen') as HTMLElement | null
      const rows = element.querySelector('.xterm-rows') as HTMLElement | null
      const viewport = element.querySelector('.xterm-viewport') as HTMLElement | null
      if (!screen || !rows || !viewport) return null
      return { element, screen, rows, viewport }
    }
    const applyRendererStyleCorrection = () => {
      if (disposed) return
      const renderer = getRendererElements()
      if (!renderer) return
      renderer.rows.style.setProperty('letter-spacing', '0px', 'important')
      renderer.rows.style.removeProperty('width')
      renderer.screen.style.removeProperty('width')
      renderer.screen.style.removeProperty('transform-origin')
      renderer.screen.style.removeProperty('transform')
      renderer.screen.style.removeProperty('will-change')
      if (attachExclusiveRef.current) {
        renderer.rows.style.setProperty('height', '100%', 'important')
        renderer.screen.style.setProperty('height', '100%', 'important')
        const cellHeight = Number(terminal?._core?._renderService?.dimensions?.css?.cell?.height)
        if (cellHeight) renderer.rows.style.setProperty('--terminal-last-row-height', `${cellHeight + Math.max(0, getAvailableSize().height - cellHeight * terminal.rows)}px`)
      } else {
        renderer.rows.style.removeProperty('height')
        renderer.screen.style.removeProperty('height')
        renderer.rows.style.removeProperty('--terminal-last-row-height')
      }
      renderer.viewport.style.setProperty('width', '100%', 'important')
    }
    const scheduleRendererStyleCorrection = () => {
      requestAnimationFrame(() => {
        applyRendererStyleCorrection()
      })
    }
    const clearTerminalRendererCache = () => {
      if (!terminal || disposed) return
      try {
        terminal.clearTextureAtlas?.()
      } catch {}
      try {
        terminal._core?._renderService?.clear?.()
      } catch {}
    }
    const recoverTerminalScreen = (reason: string, serverRedraw = false) => {
      if (!terminal || disposed) return
      controlCarryRef.current = ''
      recordMobileDebug('terminal-recover', { reason, cols: terminal.cols, rows: terminal.rows, dpr: window.devicePixelRatio || 1 })
      clearTerminalRendererCache()
      try {
        terminal.clearSelection?.()
      } catch {}
      try {
        terminal.clear?.()
      } catch {}
      try {
        terminal.reset?.()
      } catch {}
      applyTerminalOptions()
      scheduleTerminalRepaint(isMobileDevice ? MOBILE_TERMINAL_RECOVERY_REPAINT_DELAYS : TERMINAL_RECOVERY_REPAINT_DELAYS, serverRedraw)
    }
    const softRecoverTerminalScreen = (reason: string, serverRedraw = false) => {
      if (!terminal || disposed) return
      controlCarryRef.current = ''
      const stickToBottom = isMobileDevice && !isTerminalScrolledBack()
      recordMobileDebug('terminal-soft-recover', { reason, cols: terminal.cols, rows: terminal.rows, dpr: window.devicePixelRatio || 1, stickToBottom })
      clearTerminalRendererCache()
      try {
        terminal.clearSelection?.()
      } catch {}
      applyTerminalOptions()
      scheduleTerminalRepaint(isMobileDevice ? MOBILE_TERMINAL_RECOVERY_REPAINT_DELAYS : TERMINAL_RECOVERY_REPAINT_DELAYS, serverRedraw, stickToBottom, isMobileDevice)
    }
    const syncRenderEnvironment = (reason: string) => {
      const dpr = window.devicePixelRatio || 1
      if (Math.abs(dpr - lastDevicePixelRatio) <= DEVICE_PIXEL_RATIO_TOLERANCE) return false
      lastDevicePixelRatio = dpr
      if (isMobileDevice) softRecoverTerminalScreen(reason, true)
      else recoverTerminalScreen(reason, true)
      return true
    }
    const clearViewportStyles = () => {
      const element = terminal?.element as HTMLElement | null
      if (!element) return
      sharedPanX = 0
      sharedMaxPanX = 0
      if (element.style.width !== '100%') element.style.width = '100%'
      if (element.style.height !== '100%') element.style.height = '100%'
      const screen = element.querySelector('.xterm-screen') as HTMLElement | null
      const canvases = screen ? Array.from(screen.querySelectorAll('canvas:not(.xterm-link-layer)')) as HTMLCanvasElement[] : []
      if (screen?.style.transform) screen.style.removeProperty('transform')
      if (screen?.style.transformOrigin) screen.style.removeProperty('transform-origin')
      if (screen?.style.willChange) screen.style.removeProperty('will-change')
      for (const canvas of canvases) {
        canvas.style.removeProperty('transform')
        canvas.style.removeProperty('transform-origin')
      }
    }
    const syncExclusiveViewport = () => {
      const element = terminal?.element as HTMLElement | null
      if (!element) return
      if (!attachExclusiveRef.current) {
        clearViewportStyles()
        return
      }
      clearViewportStyles()
    }
    const syncSharedViewport = () => {
      const element = terminal?.element as HTMLElement | null
      if (!element) return
      if (attachExclusiveRef.current) {
        clearViewportStyles()
        return
      }
      clearViewportStyles()
    }
    afterTerminalWriteRef.current = () => {
      if (!attachExclusiveRef.current && isMobileDevice) requestAnimationFrame(syncSharedViewport)
      if (isMobileDevice && document.body.classList.contains('keyboard-open') && !isTerminalScrolledBack()) requestAnimationFrame(scrollTerminalToBottom)
    }
    const doFit = (force = false) => {
      if (!terminal || disposed) return false
      if (!attachExclusiveRef.current) return false
      try {
        const stickToBottom = isMobileDevice && !isTerminalScrolledBack()
        const currentWidth = container.clientWidth
        const currentHeight = container.clientHeight
        recordMobileDebug('terminal-fit', { force, width: currentWidth, height: currentHeight })
        if (currentWidth < 8 || currentHeight < 8) return false
        if (!force && Math.abs(currentWidth - lastFitSize.width) <= MOBILE_FIT_SIZE_TOLERANCE && Math.abs(currentHeight - lastFitSize.height) <= MOBILE_FIT_SIZE_TOLERANCE && lastSizeRef.current) {
          recordMobileDebug('terminal-fit-noop', { width: currentWidth, height: currentHeight })
          return true
        }
        applyTerminalOptions()
        const size = getFitDimensions()
        if (!size) return false
        const { cols, rows } = size
        if (cols && rows && cols > 0 && rows > 0) {
          lastFitSize = { width: currentWidth, height: currentHeight }
          if (terminal.cols !== cols || terminal.rows !== rows) {
            terminal.resize(cols, rows)
          }
          const prev = lastSizeRef.current
          const sizeChanged = !prev || prev.cols !== cols || prev.rows !== rows
          if (sizeChanged) {
            lastSizeRef.current = { cols, rows }
            const perf = useConsoleStore.getState().terminalPerf || DEFAULT_TERMINAL_PERF
            updateTerminalPerf({ layoutFitCount: perf.layoutFitCount + 1 })
            onResizeRef.current?.(cols, rows)
          }
          requestAnimationFrame(() => {
            if (disposed || !terminal) return
            scheduleRendererStyleCorrection()
            syncExclusiveViewport()
            if (force) {
              clearTerminalRendererCache()
              repaintTerminalRenderer(true, stickToBottom)
            } else if (isMobileDevice) {
              repaintTerminalRenderer(false, stickToBottom)
            }
            if (!sizeChanged && isResizeMaskVisible()) revealResizeMask()
          })
          notifyReady()
          return true
        }
      } catch (e) {
      }
      return false
    }
    const runLayoutSync = () => {
      const force = pendingLayoutForce
      const resetFont = pendingLayoutResetFont
      pendingLayoutForce = false
      pendingLayoutResetFont = false
      if (!attachExclusiveRef.current) {
        layoutRetryCount = 0
        initialFitPending = false
        mobileKeyboardTransition = false
        syncSharedLayout(resetFont)
        return
      }
      if (doFit(force)) {
        layoutRetryCount = 0
        initialFitPending = false
        mobileKeyboardTransition = false
        return
      }
      if (!force || layoutRetryCount >= 12) {
        layoutRetryCount = 0
        initialFitPending = false
        mobileKeyboardTransition = false
        return
      }
      layoutRetryCount += 1
      scheduleLayoutSync(isMobileDevice ? 32 : 16, true, resetFont)
    }
    const scheduleLayoutSync = (delay = 0, force = false, resetFont = false) => {
      if (disposed) return
      pendingLayoutForce = pendingLayoutForce || force
      pendingLayoutResetFont = pendingLayoutResetFont || resetFont
      if (layoutFrame) {
        if (initialFitPending && !force) return
        cancelAnimationFrame(layoutFrame)
        layoutFrame = null
      }
      if (layoutTimeout) {
        if (initialFitPending && !force) return
        clearTimeout(layoutTimeout)
        layoutTimeout = null
      }
      if (delay > 0) {
        layoutTimeout = setTimeout(() => {
          layoutTimeout = null
          runLayoutSync()
        }, delay)
        return
      }
      let synchronous = true
      const frame = requestAnimationFrame(() => {
        layoutFrame = null
        runLayoutSync()
        synchronous = false
      })
      if (synchronous) layoutFrame = frame
    }
    const scheduleInitialFit = () => {
      if (disposed) return
      initialFitPending = true
      scheduleLayoutSync(isMobileDevice ? 80 : 0, true)
    }
    scheduleLayoutRef.current = scheduleLayoutSync
    const scheduleStableLayout = () => {
      if (resizeStabilityFrame) return
      let synchronous = true
      const frame = requestAnimationFrame(() => {
        resizeStabilityFrame = null
        const width = container.clientWidth
        const height = container.clientHeight
        if (width !== resizeObservedSize.width || height !== resizeObservedSize.height) {
          resizeObservedSize = { width, height }
          resizeStableFrames = 0
        } else {
          resizeStableFrames += 1
        }
        if (resizeStableFrames < 2) {
          synchronous = false
          scheduleStableLayout()
          return
        }
        resizeStableFrames = 0
        scheduleLayoutSync(0, mobileKeyboardTransition, mobileKeyboardTransition)
        synchronous = false
      })
      if (synchronous) resizeStabilityFrame = frame
    }

    const syncSharedLayout = (resetFont: boolean, attempt = 0) => {
      if (!terminal || disposed || attachExclusiveRef.current) return
      const size = sharedSessionSizeRef.current
      if (!size || size.cols <= 0 || size.rows <= 0) return
      const stickToBottom = isMobileDevice && !isTerminalScrolledBack()
      if (sharedLayoutFrame) cancelAnimationFrame(sharedLayoutFrame)
      if (resetFont) {
        applyTerminalOptions()
      } else {
        terminal.options.fontFamily = preferencesRef.current.fontFamily
        terminal.options.fontWeight = '400'
        terminal.options.fontWeightBold = '700'
        terminal.options.cursorBlink = preferencesRef.current.cursorBlink
      }
      if (terminal.cols !== size.cols || terminal.rows !== size.rows) {
        terminal.resize(size.cols, size.rows)
      }
      sharedLayoutFrame = requestAnimationFrame(() => {
        if (disposed) return
        const canvas = getCanvasSize()
        if (!canvas) return
        const available = getAvailableSize()
        const widthScale = available.width / canvas.width
        const heightScale = available.height / canvas.height
        const scale = isMobileDevice ? Math.min(widthScale, Math.max(heightScale, 1)) : Math.min(widthScale, heightScale)
        if (!Number.isFinite(scale) || scale <= 0) return
        const currentFontSize = Number(terminal.options.fontSize) || preferencesRef.current.fontSize
        const nextFontSize = Math.max(6, Math.min(72, Math.round(currentFontSize * scale * 10) / 10))
        if (attempt < 2 && Math.abs(scale - 1) > 0.03 && Math.abs(nextFontSize - currentFontSize) > 0.2) {
          terminal.options.fontSize = nextFontSize
          syncSharedLayout(false, attempt + 1)
          return
        }
        if (isMobileDevice) syncSharedViewport()
        repaintTerminalRenderer(isMobileDevice, stickToBottom)
        const prev = lastSizeRef.current
        lastSizeRef.current = { cols: size.cols, rows: size.rows }
        const sizeChanged = !prev || prev.cols !== size.cols || prev.rows !== size.rows
        if (sizeChanged) {
          const perf = useConsoleStore.getState().terminalPerf || DEFAULT_TERMINAL_PERF
          updateTerminalPerf({ layoutFitCount: perf.layoutFitCount + 1 })
          onResizeRef.current?.(size.cols, size.rows)
        }
        if (!sizeChanged && isResizeMaskVisible()) revealResizeMask()
      })
    }
    const initTerminal = async () => {
      if (disposed) return
      // #region debug-point CORE:reporter
      const dbg = (hypothesisId: string, msg: string, data?: Record<string, unknown>) => { fetch('http://127.0.0.1:7777/event', { method: 'POST', keepalive: true, body: JSON.stringify({ sessionId: 'tui-input-garble', runId: 'pre-fix', hypothesisId, location: 'TerminalPane.tsx', msg: `[DEBUG] ${msg}`, data: data || {}, ts: Date.now() }) }).catch(() => {}) }
      const dbgEsc = (s: string) => JSON.stringify(s.length > 300 ? s.slice(0, 300) + '\u2026' : s).slice(1, -1)
      // #endregion
      const core = await createTerminalCore({
        container,
        preferences: preferencesRef.current,
        isMobile: isMobileDevice,
        scrollback: SCROLLBACK_LIMIT,
        ensureAppFontLoaded,
        isLinkOpenGesture,
        openUrl: (url) => openUrlInNewWindow(url, pushToast, tRef.current),
        createFileLinks: createTerminalFileLinks,
        scheduleRendererStyleCorrection,
        clearRendererCache: clearTerminalRendererCache,
        recordRenderer: (renderer) => recordMobileDebug('terminal-renderer', { renderer }),
      })
      if (!core || disposed) return
      terminal = core.terminal
      clearTerminalRendererCache()
      scheduleRendererStyleCorrection()
      const fontReady = core.fontReady
      disposables.push(...core.disposables)
      terminalInstance.current = terminal
      ;(window as typeof window & { __tmuxgoTerminal?: any }).__tmuxgoTerminal = terminal
      void loadSessionSnapshot()
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
          const text = decodeURIComponent(atob(base64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''))
          navigator.clipboard?.writeText(text)
        } catch {}
        return true
      })
      if (osc52Handler) {
        disposables.push(osc52Handler)
      }
      scheduleInitialFit()
      scheduleTerminalRepaint(isMobileDevice ? MOBILE_TERMINAL_REPAINT_DELAYS : TERMINAL_REPAINT_DELAYS, false, false, true)
      void fontReady.then(() => {
        if (disposed || terminalInstance.current !== terminal) return
        applyTerminalOptions()
        clearTerminalRendererCache()
        try {
          terminal.refresh(0, Math.max(0, terminal.rows - 1))
        } catch {}
        scheduleLayoutSync(0, true, true)
        if (!isMobileDevice) {
          if (fontLayoutTimer) clearTimeout(fontLayoutTimer)
          fontLayoutTimer = setTimeout(() => {
            fontLayoutTimer = null
            scheduleLayoutSync(0, true, true)
          }, 48)
        }
        scheduleTerminalRepaint(isMobileDevice ? MOBILE_TERMINAL_REPAINT_DELAYS : TERMINAL_REPAINT_DELAYS, false, false, true)
      })
      disposables.push(
        terminal.onData((data: string) => {
          // #region debug-point B:input-send
          dbg('B', 'input-send', { data: dbgEsc(data), len: data.length })
          // #endregion
          onInputRef.current?.(data)
        })
      )
      terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        // #region debug-point A:modifier-key
        if (e.ctrlKey || e.metaKey || e.altKey) dbg('A', 'modifier-key', { type: e.type, key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, isComposing: e.isComposing })
        // #endregion
        recordImeDebug('custom-key-handler', { key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, keyCode: e.keyCode, isComposing: e.isComposing })
        if (isImeKeyEvent(e)) return true
        const isMac = isApplePlatform()
        const modKey = isMac ? (e.ctrlKey || e.metaKey) : e.ctrlKey
        const altMod = isMac ? e.altKey : (e.altKey || e.metaKey)
        if (modKey && !altMod && e.key.toLowerCase() === 'c') {
          const selection = getSelectionText()
          if (selection) {
            selectionSync.runCopySelection(selection, true, true, focusTerminalInput)
            return false
          }
          return true
        }
        if (isPasteShortcut(e)) {
          if (e.repeat) return false
          pasteBridge.scheduleKeyboardPasteFallback()
          return false
        }
        const isPrevWordKey = (e.key === 'Backspace' || (e.code === 'Backspace' && !e.key)) && modKey && !altMod
        if (isPrevWordKey) {
          if (e.repeat || deleteWordRepeatActive) return false
          e.preventDefault()
          onInputRef.current?.(DELETE_PREV_WORD_SEQUENCE)
          startDeleteWordRepeat()
          return false
        }
        const isPrevWordRubout = (e.key === 'Backspace' || (e.code === 'Backspace' && !e.key)) && altMod && !modKey
        if (isPrevWordRubout) {
          e.preventDefault()
          onInputRef.current?.(UNIX_WORD_RUBOUT_SEQUENCE)
          return false
        }
        const isNextWordKey = (e.key === 'Delete' || (e.code === 'Delete' && !e.key)) && modKey && !altMod
        if (isNextWordKey) {
          e.preventDefault()
          onInputRef.current?.(DELETE_NEXT_WORD_SEQUENCE)
          return false
        }
        const isNextWordAlt = (e.key === 'Delete' || (e.code === 'Delete' && !e.key)) && altMod && !modKey
        if (isNextWordAlt) {
          e.preventDefault()
          onInputRef.current?.(DELETE_NEXT_WORD_SEQUENCE)
          return false
        }
        if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault()
          onInputRef.current?.(DELETE_NEXT_CHAR_SEQUENCE)
          return false
        }
        return true
      })
      disposables.push(terminal.onSelectionChange(() => {
        const selection = getSelectionText()
        selectionSync.setSelection(selection)
      }))
      const flushWriteBuffer = () => {
        // #region debug-point C:writebuffer-flush
        dbg('C', 'writebuffer-flush', { len: writeBuffer.length, writePending })
        // #endregion
        if (!writeBuffer || !terminal?.write) { writeBuffer = ''; writePending = false; return }
        const data = writeBuffer
        writeBuffer = ''
        writePending = false
        pushTerminalOutput(data)
      }
      const handleOutput = (event: Event | string | { data: string; sessionName?: string | null; hostId?: string | null; resync?: boolean }) => {
        const payload = typeof event === 'string' ? { data: event, sessionName: null, hostId: null } : event instanceof Event ? { data: String((event as CustomEvent).detail || ''), sessionName: null, hostId: null } : event
        if (payload.hostId && payload.hostId !== (activeHostIdRef.current || 'local')) return
        if (payload.sessionName && payload.sessionName !== sessionNameRef.current) return
        const raw = payload.data
        if (!raw || !terminal?.write) return
        if (payload.resync) disposeTerminalOutput()
        updateGithubDeviceLogin(raw)
        outputSinceLastAttach = true
        controlCarryRef.current = ''
        // #region debug-point E:output-mode-scan
        {
          const modeSeqs = raw.match(/\u001b\[>[0-9;]*[a-zA-Z~]|\u001b\[6n|\u001b\[\?2004[hl]|\u001b\[27;[0-9;]+~/g)
          if (modeSeqs) dbg('E', 'output-mode-seq', { seqs: JSON.stringify(modeSeqs.slice(0, 12)), len: raw.length })
        }
        // #endregion
        // #region debug-point C:output-hold
        if (pointerSyncActive || (!isMobileDevice && isDesktopImeComposing())) dbg('C', 'output-hold', { pointerSyncActive, composing: isDesktopImeComposing(), len: raw.length })
        // #endregion
        // Hold terminal paints while desktop IME is composing so candidate window stays put.
        if (pointerSyncActive || (!isMobileDevice && isDesktopImeComposing())) {
          if (payload.resync) writeBuffer = raw
          else writeBuffer += raw
          if (pointerSyncActive && !writePending && !isDesktopImeComposing()) {
            writePending = true
            requestAnimationFrame(flushWriteBuffer)
          }
          return
        }
        pushTerminalOutput(raw)
      }
      let unsubscribeOutput = () => {}
      const subscribeTerminalOutput = () => {
        unsubscribeOutput()
        const hostId = activeHostIdRef.current || 'local'
        const targetSessionName = sessionNameRef.current || ''
        unsubscribeOutput = targetSessionName ? subscribeOutputRef.current(hostId, targetSessionName, handleOutput) : () => {}
      }
      resubscribeOutputRef.current = subscribeTerminalOutput
      subscribeTerminalOutput()
      const handleCopySelection = (event: Event) => {
        const selection = getSelectionText()
        window.dispatchEvent(new CustomEvent('tmuxgo-terminal-selection', { detail: { requestId: (event as CustomEvent).detail?.requestId, selection } }))
      }
      window.addEventListener('tmuxgo-copy-terminal-selection', handleCopySelection as EventListener)
      const handleWindowResize = () => {
        syncRenderEnvironment('window-resize')
        if (lastContainerSize.width > 0 && lastContainerSize.height > 0) {
          if (!isMobileDevice) showResizeMask()
          resizeObservedSize = { width: container.clientWidth, height: container.clientHeight }
          resizeStableFrames = 0
          scheduleStableLayout()
        }
      }
      const handleKeyUp = (e: KeyboardEvent) => {
        recordImeDebug('window-keyup', { key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, isComposing: e.isComposing })
        if (e.key === 'Backspace' || !e.ctrlKey) stopDeleteWordRepeat()
      }
      const handleOrientationChange = () => {
        mobileKeyboardTransition = true
        softRecoverTerminalScreen('orientationchange', true)
      }
      const handleKeyboardChange = (event: Event) => {
        const detail = (event as CustomEvent<{ open?: boolean }>).detail
        const nextOpen = typeof detail?.open === 'boolean' ? detail.open : document.body.classList.contains('keyboard-open')
        if (nextOpen === lastKeyboardOpen) return
        lastKeyboardOpen = nextOpen
        if (isMobileDevice) cancelTmuxCopyMode()
        if (isMobileDevice && attachExclusiveRef.current) mobileKeyboardTransition = true
      }
      const handleAttached = (event: Event) => {
        const detail = (event as CustomEvent).detail || {}
        if (detail.hostId && detail.hostId !== (activeHostIdRef.current || 'local')) return
        if (detail.sessionName && detail.sessionName !== sessionNameRef.current) return
        const cols = Number(detail.cols)
        const rows = Number(detail.rows)
        if (!terminal || disposed) return
        const hadOutputBeforeAttach = outputSinceLastAttach
        outputSinceLastAttach = false
        attachEventCount += 1
        const initialAttach = attachEventCount === 1
        const softRecover = initialAttach && hadOutputBeforeAttach
        const snapshot = loadSessionSnapshot()
        const generation = resizeMaskGeneration
        void snapshot.catch(() => null).then(() => {
          if (!terminalResizePending || disposed || generation !== resizeMaskGeneration || cols !== terminal?.cols || rows !== terminal?.rows) return
          revealResizeMask(generation)
        })
        if (attachExclusiveRef.current) {
          const size = lastSizeRef.current
          const sizeChanged = !size || size.cols !== cols || size.rows !== rows
          if (sizeChanged) scheduleInitialFit()
          if (softRecover) scheduleTerminalRepaint(isMobileDevice ? MOBILE_TERMINAL_REPAINT_DELAYS : TERMINAL_REPAINT_DELAYS)
          else if (sizeChanged) softRecoverTerminalScreen('attached', true)
          return
        }
        if (cols > 0 && rows > 0) {
          const prevSharedSize = sharedSessionSizeRef.current
          const sizeChanged = !prevSharedSize || prevSharedSize.cols !== cols || prevSharedSize.rows !== rows
          sharedSessionSizeRef.current = { cols, rows }
          if (sizeChanged) scheduleLayoutSync(0, true, true)
          if (softRecover) scheduleTerminalRepaint(isMobileDevice ? MOBILE_TERMINAL_REPAINT_DELAYS : TERMINAL_REPAINT_DELAYS)
          else if (sizeChanged) softRecoverTerminalScreen('attached', true)
        }
      }
      const handleResized = (event: Event) => {
        const detail = (event as CustomEvent).detail || {}
        if (detail.hostId && detail.hostId !== (activeHostIdRef.current || 'local')) return
        if (detail.sessionName && detail.sessionName !== sessionNameRef.current) return
        const cols = Number(detail.cols)
        const rows = Number(detail.rows)
        if (!terminal || cols !== terminal.cols || rows !== terminal.rows || detail.localOnly && !attachEventCount) return
        const generation = resizeMaskGeneration
        if (detail.localOnly) {
          revealResizeMask(generation)
          return
        }
        void loadSessionSnapshot(true).catch(() => null)
        if (disposed || generation !== resizeMaskGeneration || cols !== terminal?.cols || rows !== terminal?.rows) return
        revealResizeMask(generation)
      }
      const handleResizeAbort = (event: Event) => {
        const detail = (event as CustomEvent).detail || {}
        if (detail.hostId && detail.hostId !== (activeHostIdRef.current || 'local')) return
        if (detail.sessionName && detail.sessionName !== sessionNameRef.current) return
        if (terminalResizePending) revealResizeMask()
      }
      const handleLayoutChange = (event: Event) => {
        const detail = (event as CustomEvent).detail || {}
        if (detail.reason === 'attached') return
        if (helperTextareaComposing || document.body.classList.contains('ime-composing')) return
        const mobileKeyboardLayout = isMobileDevice && detail.reason === 'viewport-sync'
        const stickToBottom = isMobileDevice && (detail.keyboardOpen || !isTerminalScrolledBack())
        if (mobileKeyboardLayout) {
          mobileKeyboardTransition = true
          scheduleTerminalRepaint(MOBILE_TERMINAL_KEYBOARD_REPAINT_DELAYS, false, stickToBottom, true)
          return
        }
        if (detail.reason === 'terminal-panel-resize-end') {
          scheduleLayoutSync(0, true, true)
          scheduleTerminalRepaint(LAYOUT_REPAINT_DELAYS)
          return
        }
        if (detail.reason === 'tmux-pane-resize') {
          scheduleTerminalRepaint(LAYOUT_REPAINT_DELAYS)
          return
        }
        scheduleTerminalRepaint(isMobileDevice ? MOBILE_TERMINAL_REPAINT_DELAYS : LAYOUT_REPAINT_DELAYS, false, stickToBottom)
      }
      const handleVisibilityChange = () => {
        if (document.hidden) {
          stopDeleteWordRepeat()
          return
        }
        const recovered = syncRenderEnvironment('visibilitychange')
        scheduleLayoutSync(0, true)
        if (isMobileDevice && !recovered) {
          recoverTerminalScreen('visibilitychange')
          return
        }
        if (recovered) return
        scheduleTerminalRepaint(isMobileDevice ? MOBILE_TERMINAL_REPAINT_DELAYS : TERMINAL_REPAINT_DELAYS)
      }
      const handlePageShow = () => {
        const recovered = syncRenderEnvironment('pageshow')
        scheduleLayoutSync(0, true)
        if (isMobileDevice && !recovered) recoverTerminalScreen('pageshow')
      }
      window.addEventListener('tmux-attached', handleAttached as EventListener)
      window.addEventListener('tmux-resized', handleResized as EventListener)
      window.addEventListener('tmux-error', handleResizeAbort as EventListener)
      window.addEventListener('tmux-detached', handleResizeAbort as EventListener)
      window.addEventListener('tmuxgo-layout-change', handleLayoutChange as EventListener)
      window.addEventListener('resize', handleWindowResize)
      window.addEventListener('keyup', handleKeyUp)
      window.addEventListener('blur', stopDeleteWordRepeat)
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
      const handleHelperCompositionStart = () => {
        // #region debug-point D:ime-start
        dbg('D', 'ime-composition-start')
        // #endregion
        helperTextareaComposing = true
        document.body.classList.add('ime-composing')
        if (pendingPostImeSyncTimer) {
          clearTimeout(pendingPostImeSyncTimer)
          pendingPostImeSyncTimer = null
        }
        recordImeDebug('helper-compositionstart', { value: helperTextarea?.value || '' })
      }
      const handleHelperCompositionEnd = () => {
        // #region debug-point D:ime-end
        dbg('D', 'ime-composition-end')
        // #endregion
        helperTextareaComposing = false
        document.body.classList.remove('ime-composing')
        recordImeDebug('helper-compositionend', { value: helperTextarea?.value || '' })
        requestAnimationFrame(() => {
          flushWriteBuffer()
        })
        if (pendingPostImeSyncTimer) clearTimeout(pendingPostImeSyncTimer)
        pendingPostImeSyncTimer = setTimeout(() => {
          pendingPostImeSyncTimer = null
          syncHelperTextareaGeometry()
        }, 300)
      }
      const handleHelperCompositionUpdate = (event: CompositionEvent) => {
        recordImeDebug('helper-compositionupdate', { data: event.data || '', value: helperTextarea?.value || '' })
      }
      const handleHelperFocus = () => {
        recordImeDebug('helper-focus', { value: helperTextarea?.value || '' })
      }
      const handleHelperBlur = () => {
        recordImeDebug('helper-blur', { value: helperTextarea?.value || '' })
        if (!helperTextareaComposing) return
        helperTextareaComposing = false
        document.body.classList.remove('ime-composing')
        requestAnimationFrame(() => {
          flushWriteBuffer()
        })
        if (pendingPostImeSyncTimer) clearTimeout(pendingPostImeSyncTimer)
        pendingPostImeSyncTimer = setTimeout(() => {
          pendingPostImeSyncTimer = null
          syncHelperTextareaGeometry()
        }, 300)
      }
      const handleHelperBeforeInput = (event: InputEvent) => {
        recordImeDebug('helper-beforeinput', { inputType: event.inputType || '', data: event.data || '', value: helperTextarea?.value || '', composing: event.isComposing })
      }
      const handleHelperInput = (event: InputEvent) => {
        recordImeDebug('helper-input', { inputType: event.inputType || '', data: event.data || '', value: helperTextarea?.value || '', composing: event.isComposing })
      }
      const handleHelperKeyDown = (event: KeyboardEvent) => {
        recordImeDebug('helper-keydown', { key: event.key, code: event.code, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, keyCode: event.keyCode, isComposing: event.isComposing })
      }
      const handleHelperKeyUp = (event: KeyboardEvent) => {
        recordImeDebug('helper-keyup', { key: event.key, code: event.code, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, keyCode: event.keyCode, isComposing: event.isComposing })
      }
      const clearPointerSync = () => {
        pointerSyncActive = false
        flushWriteBuffer()
      }
      const armPointerSync = () => {
        pointerSyncActive = true
      }
    const handlePointerSync = (event?: MouseEvent | TouchEvent) => {
      if (!pointerSyncActive) return
      pointerSyncActive = false
      if (isDesktopImeComposing()) return
      flushWriteBuffer()
      selectionSync.clearCopySelectionTimer()
      selectionSync.runCopySelection(getSelectionText() || selectionSync.currentSelectionRef.current, true, true, focusTerminalInput)
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
        if (isDesktopImeComposing()) return
        focusTerminalInput()
        requestAnimationFrame(() => {
          if (!isDesktopImeComposing()) focusTerminalInput()
        })
        setTimeout(() => {
          if (!isDesktopImeComposing()) focusTerminalInput()
        }, 0)
      }
      const clipboardIme = createTerminalClipboardIme({
        container,
        helperTextarea,
        handleCopy,
        handleCompositionStart: handleHelperCompositionStart,
        handleCompositionUpdate: handleHelperCompositionUpdate,
        handleCompositionEnd: handleHelperCompositionEnd,
        handleFocus: handleHelperFocus,
        handleBlur: handleHelperBlur,
        handleBeforeInput: handleHelperBeforeInput,
        handleInput: handleHelperInput,
        handleKeyDown: handleHelperKeyDown,
        handleKeyUp: handleHelperKeyUp,
        handlePaste: pasteBridge.handlePaste as EventListener,
        handlePasteInput: pasteBridge.handlePasteInput as EventListener,
        armPointerSync,
        handlePointerSync: handlePointerSync as (event?: MouseEvent | TouchEvent) => void,
        clearPointerSync,
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
          window.removeEventListener('blur', stopDeleteWordRepeat)
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
      lastContainerSize = { width: container.clientWidth, height: container.clientHeight }
      resizeObservedSize = lastContainerSize
      resizeObserver = new ResizeObserver(() => {
        const width = container.clientWidth
        const height = container.clientHeight
        recordMobileDebug('terminal-resize-observer', { width, height })
        if (Math.abs(width - lastContainerSize.width) <= MOBILE_FIT_SIZE_TOLERANCE && Math.abs(height - lastContainerSize.height) <= MOBILE_FIT_SIZE_TOLERANCE) return
        const hadContainerSize = lastContainerSize.width > 0 && lastContainerSize.height > 0
        lastContainerSize = { width, height }
        resizeObservedSize = { width, height }
        resizeStableFrames = 0
        if (hadContainerSize && !isMobileDevice) showResizeMask()
        scheduleStableLayout()
      })
      resizeObserver.observe(container)
      container.addEventListener('touchstart', handlePinchTouchStart, { passive: true })
      container.addEventListener('touchmove', handlePinchTouchMove, { passive: false })
      container.addEventListener('touchend', handlePinchTouchEnd, { passive: true })
      container.addEventListener('touchcancel', handlePinchTouchCancel, { passive: true })
      container.addEventListener('wheel', handleDesktopPinch, { capture: true, passive: false })
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
          container.removeEventListener('touchstart', handlePinchTouchStart)
          container.removeEventListener('touchmove', handlePinchTouchMove)
          container.removeEventListener('touchend', handlePinchTouchEnd)
          container.removeEventListener('touchcancel', handlePinchTouchCancel)
          container.removeEventListener('wheel', handleDesktopPinch, true)
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
    initTerminal().catch(console.error)
    return () => {
      disposed = true
      stopDeleteWordRepeat()
      paneResize.hide()
      if (layoutTimeout) clearTimeout(layoutTimeout)
      if (fontLayoutTimer) clearTimeout(fontLayoutTimer)
      if (pendingPostImeSyncTimer) {
        clearTimeout(pendingPostImeSyncTimer)
        pendingPostImeSyncTimer = null
      }
      if (resizeRevealFrame) cancelAnimationFrame(resizeRevealFrame)
      if (resizeStabilityFrame) cancelAnimationFrame(resizeStabilityFrame)
      if (resizeMaskFailsafeTimer) {
        clearTimeout(resizeMaskFailsafeTimer)
        resizeMaskFailsafeTimer = null
      }
      terminalResizePending = false
      resizeMaskRef.current?.replaceChildren()
      if (layoutFrame) cancelAnimationFrame(layoutFrame)
      clearTerminalRepaint()
      if (sharedLayoutFrame) cancelAnimationFrame(sharedLayoutFrame)
      afterTerminalWriteRef.current = () => {}
      disposeTerminalOutput()
      resizeObserver?.disconnect()
      disposables.forEach((d) => d?.dispose?.())
      document.body.classList.remove('ime-composing')
      terminal?.dispose()
      terminalInstance.current = null
      scheduleLayoutRef.current = () => {}
    }
  }, [disposeTerminalOutput, ensureFileRoots, handleDesktopPinch, handlePinchTouchCancel, handlePinchTouchEnd, handlePinchTouchMove, handlePinchTouchStart, openUploadDialog, preferencesReady, pushToast, pushTerminalOutput, queryClient, selectionSync, setActivePane, syncPaneCwd, touchScroll, updateGithubDeviceLogin, updateTerminalPerf])

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
      <div ref={resizeMaskRef} data-testid="terminal-resize-mask" aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 hidden overflow-hidden bg-bg-1" style={{ display: terminalResizePending ? 'block' : undefined }} />
      <div ref={paneResizeGuideRef} data-testid="pane-resize-guide" className="pointer-events-none absolute z-20 hidden bg-accent shadow-[0_0_6px_var(--accent)]" />
      {dropState.isDropActive && <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-apple border border-dashed border-accent bg-bg-0/70 text-sm text-accent shadow-[var(--glow)]">{t('terminal.dropUpload')}</div>}
      {githubDeviceLogin && <div data-testid="github-device-login-card" className="absolute inset-x-3 bottom-3 z-20 ml-auto w-auto max-w-sm rounded-apple border border-accent/30 bg-bg-0/92 p-3 shadow-[0_18px_48px_rgba(0,0,0,0.38)] backdrop-blur" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-text-1">{t('githubAuth.title')}</div>
            <div className="mt-1 text-xs leading-5 text-text-3">{t('githubAuth.desc')}</div>
          </div>
          <Chip tone="danger" className="shrink-0" aria-label={t('githubAuth.dismiss')} onClick={dismissGithubDeviceLogin}>✕</Chip>
        </div>
        <div className="mt-3 rounded-apple border border-[var(--line)] bg-bg-1 px-3 py-2">
          <div className="text-caption uppercase tracking-[0.24em] text-text-3">{t('githubAuth.code')}</div>
          <div className="mt-1 font-mono text-base tracking-[0.22em] text-accent">{githubDeviceLogin.code}</div>
        </div>
        <div className="mt-3 flex gap-2">
          <button type="button" data-testid="github-device-login-open" onClick={openGithubDeviceLogin} className="flex-1 rounded-apple bg-accent px-3 py-2 text-sm font-medium text-bg-0 transition-transform active:scale-[0.98]">{t('githubAuth.open')}</button>
          <button type="button" data-testid="github-device-login-copy" onClick={() => void copyGithubDeviceLogin()} className="flex-1 rounded-apple border border-[var(--line)] bg-bg-1 px-3 py-2 text-sm text-text-2 transition-transform active:scale-[0.98]">{t('githubAuth.copy')}</button>
        </div>
      </div>}
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
