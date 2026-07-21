'use client'
import { useEffect, useRef, useCallback, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import { usePreferences } from '@/hooks/usePreferences'
import { useMobileKeyboard } from '@/hooks/useMobileKeyboard'
import { useWebSocket } from '@/hooks/useWebSocket'
import { DELETE_NEXT_WORD_SEQUENCE, DELETE_PREV_WORD_SEQUENCE } from '@/lib/terminal-keys'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { api } from '@/lib/api'
import { useTerminalOutput } from '@/hooks/useTerminalOutput'
import { useTerminalDrop } from '@/hooks/useTerminalDrop'
import { useTerminalPasteBridge } from '@/hooks/useTerminalPasteBridge'
import { useOptionalQueryClient } from '@/hooks/useOptionalQueryClient'
import { useTerminalSelectionSync } from '@/hooks/useTerminalSelectionSync'
import { useTranslation } from '@/i18n'
import { useTerminalTouchScroll } from '@/hooks/useTerminalTouchScroll'
import { recordMobileDiagnostic } from '@/lib/mobile-diagnostics'
import { recordImeDiagnostic } from '@/lib/ime-diagnostics'
import { useTerminalOutputScheduler } from '@/hooks/useTerminalOutputScheduler'
import { buildSessionId } from '@/lib/session-id'
import { writeClipboardText } from '@/lib/clipboard-text'
import { openFileInEditor } from '@/lib/editor-open'
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
const MOBILE_FIT_DEBOUNCE_MS = 96
const MOBILE_FIT_SIZE_TOLERANCE = 2
const DEVICE_PIXEL_RATIO_TOLERANCE = 0.01
const MOBILE_PINCH_MIN_FONT_SIZE = 8
const MOBILE_PINCH_MAX_FONT_SIZE = 20
const MOBILE_PINCH_FONT_SIZE_EPSILON = 0.04
const MOBILE_PINCH_DISTANCE_EPSILON = 2
const GITHUB_DEVICE_LOGIN_URL = 'https://github.com/login/device'
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
  subscribeOutput?: (listener: (message: { data: string; sessionName?: string | null; hostId?: string | null; resync?: boolean }) => void) => () => void
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

export function TerminalPane({ sessionName, onInput, onResize, attachExclusive = false, onReady, subscribeOutput, onSwipeLeft, onSwipeRight }: TerminalPaneProps) {
  const { preferences, updatePreferences } = usePreferences()
  const { t } = useTranslation()
  const activeHostId = useConsoleStore((s) => s.activeHostId)
  const pushToast = useConsoleStore((s) => s.pushToast)
  const openUploadDialog = useConsoleStore((s) => s.openUploadDialog)
  const setActivePane = useConsoleStore((s) => s.setActivePane)
  const updateTerminalPerf = useConsoleStore((s) => s.updateTerminalPerf)
  const recordTerminalOutput = useTerminalOutput()
  const queryClient = useOptionalQueryClient()
  const terminalRef = useRef<HTMLDivElement>(null)
  const touchMovedRef = useRef(false)
  const terminalInstance = useRef<any>(null)
  const fitAddonRef = useRef<any>(null)
  const [githubDeviceLogin, setGithubDeviceLogin] = useState<{ code: string; url: string } | null>(null)
  const onInputRef = useRef(onInput)
  const onResizeRef = useRef(onResize)
  const attachExclusiveRef = useRef(attachExclusive)
  const onReadyRef = useRef(onReady)
  const sessionNameRef = useRef(sessionName)
  const preferencesRef = useRef(preferences)
  const subscribeOutputRef = useRef(subscribeOutput)
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const sharedSessionSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const controlCarryRef = useRef('')
  const lastTapRef = useRef<{ x: number; y: number } | null>(null)
  const scheduleFitRef = useRef<(delay?: number, force?: boolean) => void>(() => {})
  const forceStableFitRef = useRef<() => void>(() => {})
  const syncSharedLayoutRef = useRef<(resetFont: boolean) => void>(() => {})
  const activeHostIdRef = useRef(activeHostId)
  const exclusiveLineHeightRef = useRef(1)
  const sessionSnapshotRef = useRef<any | null>(null)
  const sessionSnapshotRequestRef = useRef<{ key: string; promise: Promise<any> } | null>(null)
  const sessionSnapshotLoadedRef = useRef({ key: '', at: 0 })
  const updatePreferencesRef = useRef(updatePreferences)
  const tRef = useRef(t)
  const afterTerminalWriteRef = useRef<() => void>(() => {})
  const pinchStateRef = useRef({ active: false, startDistance: 0, startFontSize: preferences.fontSize, lastFontSize: preferences.fontSize })
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

  const { send } = useWebSocket()
  const sendRef = useRef(send)
  const sendInput = useCallback((data: string) => onInputRef.current?.(data), [])
  const { textareaRef, focusKeyboard, isMobile: isMobileDevice } = useMobileKeyboard(sendInput, terminalRef)
  const dropState = useTerminalDrop(sendInput, openUploadDialog)
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
  const clampMobileFontSize = useCallback((value: number) => {
    const rounded = Math.round(value * 10) / 10
    return Math.max(MOBILE_PINCH_MIN_FONT_SIZE, Math.min(MOBILE_PINCH_MAX_FONT_SIZE, rounded))
  }, [])
  const getPinchDistance = useCallback((touches: TouchList) => {
    if (touches.length < 2) return 0
    const dx = touches[0].clientX - touches[1].clientX
    const dy = touches[0].clientY - touches[1].clientY
    return Math.hypot(dx, dy)
  }, [])
  const applyPinchFontSize = useCallback((fontSize: number) => {
    const terminal = terminalInstance.current
    if (!terminal) return
    terminal.options.fontSize = fontSize
    if (attachExclusiveRef.current) scheduleFitRef.current(0, true)
    else syncSharedLayoutRef.current(true)
  }, [])
  const beginPinch = useCallback((touches: TouchList) => {
    if (!isMobileDevice || touches.length < 2) return
    const distance = getPinchDistance(touches)
    if (!Number.isFinite(distance) || distance < MOBILE_PINCH_DISTANCE_EPSILON) return
    const currentFontSize = Number(terminalInstance.current?.options?.fontSize) || preferencesRef.current.fontSize
    const startFontSize = clampMobileFontSize(currentFontSize)
    pinchStateRef.current.active = true
    pinchStateRef.current.startDistance = distance
    pinchStateRef.current.startFontSize = startFontSize
    pinchStateRef.current.lastFontSize = startFontSize
    touchMovedRef.current = true
  }, [clampMobileFontSize, getPinchDistance, isMobileDevice])
  const commitPinch = useCallback(() => {
    const state = pinchStateRef.current
    if (!state.active) return
    state.active = false
    const nextFontSize = clampMobileFontSize(state.lastFontSize || state.startFontSize || preferencesRef.current.fontSize)
    state.startDistance = 0
    state.startFontSize = nextFontSize
    state.lastFontSize = nextFontSize
    if (Math.abs(nextFontSize - preferencesRef.current.fontSize) < MOBILE_PINCH_FONT_SIZE_EPSILON) return
    updatePreferencesRef.current({ fontSize: nextFontSize })
  }, [clampMobileFontSize])
  const handlePinchTouchStart = useCallback((e: TouchEvent) => {
    if (!isMobileDevice) return
    if (e.touches.length < 2) return
    beginPinch(e.touches)
  }, [beginPinch, isMobileDevice])
  const handlePinchTouchMove = useCallback((e: TouchEvent) => {
    if (!isMobileDevice || e.touches.length < 2) return
    if (!pinchStateRef.current.active) beginPinch(e.touches)
    if (!pinchStateRef.current.active) return
    e.preventDefault()
    touchMovedRef.current = true
    const state = pinchStateRef.current
    const distance = getPinchDistance(e.touches)
    if (!Number.isFinite(distance) || distance < MOBILE_PINCH_DISTANCE_EPSILON || state.startDistance < MOBILE_PINCH_DISTANCE_EPSILON) return
    const nextFontSize = clampMobileFontSize(state.startFontSize * (distance / state.startDistance))
    if (Math.abs(nextFontSize - state.lastFontSize) < MOBILE_PINCH_FONT_SIZE_EPSILON) return
    state.lastFontSize = nextFontSize
    applyPinchFontSize(nextFontSize)
  }, [applyPinchFontSize, beginPinch, clampMobileFontSize, getPinchDistance, isMobileDevice])
  const handlePinchTouchEnd = useCallback((e: TouchEvent) => {
    if (!pinchStateRef.current.active) return
    touchMovedRef.current = true
    if (e.touches.length >= 2) {
      const distance = getPinchDistance(e.touches)
      if (Number.isFinite(distance) && distance >= MOBILE_PINCH_DISTANCE_EPSILON) {
        pinchStateRef.current.startDistance = distance
        pinchStateRef.current.startFontSize = pinchStateRef.current.lastFontSize
      }
      return
    }
    commitPinch()
  }, [commitPinch, getPinchDistance])
  const handlePinchTouchCancel = useCallback(() => {
    if (!pinchStateRef.current.active) return
    touchMovedRef.current = true
    commitPinch()
  }, [commitPinch])
  const touchScroll = useTerminalTouchScroll({
    isMobile: isMobileDevice,
    onScroll: handleTouchScroll,
    onTap: handleTouchTap,
    onTouchMovedChange: handleTouchMovedChange,
    onSwipeLeft,
    onSwipeRight,
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
    exclusiveLineHeightRef.current = 1
  }, [sessionName])
  useEffect(() => {
    preferencesRef.current = preferences
  }, [preferences])
  useEffect(() => {
    subscribeOutputRef.current = subscribeOutput
  }, [subscribeOutput])
  useEffect(() => {
    activeHostIdRef.current = activeHostId
  }, [activeHostId])
  useEffect(() => {
    paneCwdRef.current = ''
    sessionSnapshotRef.current = null
    sessionSnapshotRequestRef.current = null
    sessionSnapshotLoadedRef.current = { key: '', at: 0 }
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
    terminal.options.fontSize = preferences.fontSize
    terminal.options.fontFamily = preferences.fontFamily
    if (attachExclusiveRef.current) {
      scheduleFitRef.current(0, true)
    } else {
      syncSharedLayoutRef.current(true)
    }
  }, [preferences.fontSize, preferences.fontFamily])

  useEffect(() => {
    if (!terminalRef.current) return
    const container = terminalRef.current
    let terminal: any = null
    let fitAddon: any = null
    let resizeObserver: ResizeObserver | null = null
    let disposables: any[] = []
    let fitTimeout: NodeJS.Timeout | null = null
    let stableFitTimer: ReturnType<typeof setTimeout> | null = null
    let sharedLayoutFrame: number | null = null
    let fitFrame: number | null = null
    let repaintFrame: number | null = null
    let repaintTimers: ReturnType<typeof setTimeout>[] = []
    let disposed = false
    let readyNotified = false
    let sharedPanX = 0
    let sharedMaxPanX = 0
    let lastContainerSize = { width: 0, height: 0 }
    let lastFitSize = { width: 0, height: 0 }
    let pendingFitSize = { width: 0, height: 0 }
    let stableFitToken = 0
    let lastRefreshAt = 0
    let lastDevicePixelRatio = window.devicePixelRatio || 1
    let deleteWordRepeatTimer: ReturnType<typeof setTimeout> | null = null
    let deleteWordRepeatActive = false
    let pointerSyncActive = false
    let helperTextareaComposing = false
    let helperTextarea: HTMLTextAreaElement | null | undefined = null
    let lastKeyboardOpen = document.body.classList.contains('keyboard-open')
    let paneResizeDrag: any = null
    let paneBoundsCache: { snapshot: any; windowId: string; bounds: any[] } | null = null
    let paneResizeHoverThrottle = 0
    let writeBuffer = ''
    let writePending = false
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
    const syncHelperTextareaGeometry = () => {
      const input = helperTextarea || container.querySelector('.xterm-helper-textarea, textarea')
      if (!(input instanceof HTMLTextAreaElement) || !terminal) return
      if (helperTextareaComposing) return
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
      input.style.left = `${cursorX * cellWidth}px`
      input.style.top = `${cursorY * cellHeight}px`
      input.style.width = `${cellWidth}px`
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
      const input = helperTextarea || container.querySelector('.xterm-helper-textarea, textarea')
      if (input instanceof HTMLTextAreaElement && helperTextareaComposing) return
      terminal?.focus?.()
      if (input instanceof HTMLTextAreaElement) syncHelperTextareaGeometry()
      if (document.activeElement !== input && !(input instanceof HTMLTextAreaElement && helperTextareaComposing)) container.focus()
      if (input instanceof HTMLTextAreaElement && document.activeElement !== input) input.focus({ preventScroll: true })
      if (input instanceof HTMLTextAreaElement) {
        syncHelperTextareaGeometry()
        requestAnimationFrame(syncHelperTextareaGeometry)
        setTimeout(syncHelperTextareaGeometry, 0)
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
    const getPaneBounds = (pane: any) => {
      const id = String(pane?.id ?? pane?.tmuxPaneId ?? '')
      const left = Number(pane?.left ?? pane?.position?.left)
      const top = Number(pane?.top ?? pane?.position?.top)
      const cols = Number(pane?.size?.cols ?? pane?.cols)
      const rows = Number(pane?.size?.rows ?? pane?.rows)
      if (![left, top, cols, rows].every(Number.isFinite) || cols <= 0 || rows <= 0) return null
      return { id, left, top, cols, rows }
    }
    const getCachedPaneBounds = () => {
      const snapshot = readSessionSnapshot()
      if (!snapshot) return [] as any[]
      const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : []
      const activeWindow = windows.find((item: any) => item.id === snapshot?.activeWindowId) || windows.find((item: any) => item.active)
      const activePaneId = String(snapshot?.activePaneId || '')
      const windowId = String(activeWindow?.id || '')
      if (paneBoundsCache && paneBoundsCache.snapshot === snapshot && paneBoundsCache.windowId === windowId) {
        return paneBoundsCache.bounds
      }
      const panes = Array.isArray(snapshot?.panes) ? snapshot.panes : []
      const filtered = windowId ? panes.filter((pane: any) => String(pane.windowId || '') === windowId) : panes
      const visiblePanes = activeWindow?.zoomed && activePaneId ? filtered.filter((pane: any) => String(pane?.id || pane?.tmuxPaneId || '') === activePaneId) : filtered
      const bounds = visiblePanes.map(getPaneBounds).filter(Boolean) as any[]
      paneBoundsCache = { snapshot, windowId, bounds }
      return bounds
    }
    const getPaneSelectionText = () => {
      const position = terminal?.getSelectionPosition?.()
      const start = position?.start
      const end = position?.end
      if (!start || !end) return ''
      const startBeforeEnd = start.y < end.y || start.y === end.y && start.x <= end.x
      const first = startBeforeEnd ? start : end
      const last = startBeforeEnd ? end : start
      const pane = getCachedPaneBounds().find((item) => first.x >= item.left && first.x < item.left + item.cols && first.y >= item.top && first.y < item.top + item.rows)
      if (!pane) return ''
      const baseY = Number(terminal?.buffer?.active?.baseY) || 0
      const fromY = Math.max(pane.top, first.y)
      const toY = Math.min(pane.top + pane.rows - 1, last.y)
      const lines: string[] = []
      for (let y = fromY; y <= toY; y += 1) {
        const line = terminal?.buffer?.active?.getLine?.(baseY + y)
        if (!line) continue
        const fromX = y === first.y ? Math.max(pane.left, first.x) : pane.left
        const toX = y === last.y ? Math.min(pane.left + pane.cols, last.x) : pane.left + pane.cols
        if (toX < fromX) continue
        lines.push(line.translateToString(true, fromX, toX))
      }
      return lines.join('\n')
    }
    const getSelectionText = () => getPaneSelectionText() || terminal?.getSelection?.() || window.getSelection?.()?.toString() || ''
    const getMouseCell = (event: MouseEvent) => {
      const screen = terminal?.element?.querySelector('.xterm-screen') as HTMLElement | null
      if (!screen || !terminal?.cols || !terminal?.rows) return null
      const rect = screen.getBoundingClientRect()
      if (!rect.width || !rect.height) return null
      const dims = terminal?._core?._renderService?.dimensions?.css
      const cellWidth = Number(dims?.cell?.width) || rect.width / terminal.cols
      const cellHeight = Number(dims?.cell?.height) || rect.height / terminal.rows
      if (!Number.isFinite(cellWidth) || !Number.isFinite(cellHeight) || cellWidth <= 0 || cellHeight <= 0) return null
      const x = Math.floor((event.clientX - rect.left) / cellWidth)
      const y = Math.floor((event.clientY - rect.top) / cellHeight)
      if (x < 0 || y < 0 || x >= terminal.cols || y >= terminal.rows) return null
      return { x, y }
    }
    const getPaneIdByMouseCell = (cell: { x: number; y: number } | null) => {
      if (!cell) return null
      const pane = getCachedPaneBounds().find((item) => cell.x >= item.left && cell.x < item.left + item.cols && cell.y >= item.top && cell.y < item.top + item.rows)
      return pane?.id || null
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
    const rangesOverlap = (aStart: number, aEnd: number, bStart: number, bEnd: number) => Math.max(aStart, bStart) <= Math.min(aEnd, bEnd)
    const getPaneResizeTarget = (event: MouseEvent) => {
      if (event.button !== 0 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return null
      const cell = getMouseCell(event)
      if (!cell) return null
      const panes = getCachedPaneBounds()
      if (!panes.length) return null
      const vertical = panes.find((pane) => {
        if (!pane.id) return false
        const edge = pane.left + pane.cols
        if (Math.abs(cell.x - edge) > 1 || cell.y < pane.top || cell.y >= pane.top + pane.rows) return false
        return panes.some((other) => other.left === edge + 1 && rangesOverlap(pane.top, pane.top + pane.rows - 1, other.top, other.top + other.rows - 1))
      })
      if (vertical) return { axis: 'x', paneId: vertical.id, startCell: vertical.left + vertical.cols, startSize: vertical.cols }
      const horizontal = panes.find((pane) => {
        if (!pane.id) return false
        const edge = pane.top + pane.rows
        if (Math.abs(cell.y - edge) > 1 || cell.x < pane.left || cell.x >= pane.left + pane.cols) return false
        return panes.some((other) => other.top === edge + 1 && rangesOverlap(pane.left, pane.left + pane.cols - 1, other.left, other.left + other.cols - 1))
      })
      if (horizontal) return { axis: 'y', paneId: horizontal.id, startCell: horizontal.top + horizontal.rows, startSize: horizontal.rows }
      return null
    }
    const updatePaneResizeDrag = (event: MouseEvent) => {
      const drag = paneResizeDrag
      if (!drag) return
      const cell = getMouseCell(event)
      if (!cell) return
      const delta = (drag.axis === 'x' ? cell.x : cell.y) - drag.startCell
      const nextSize = Math.max(4, drag.startSize + delta)
      if (nextSize === drag.pendingSize) return
      drag.pendingSize = nextSize
    }
    const handlePaneResizeMove = (event: MouseEvent) => {
      if (!paneResizeDrag) return
      event.preventDefault()
      updatePaneResizeDrag(event)
    }
    const endPaneResizeDrag = () => {
      const drag = paneResizeDrag
      if (!drag) return
      drag.released = true
      if (!drag.pendingSize || drag.pendingSize === drag.sentSize) {
        paneResizeDrag = null
        container.style.cursor = ''
        window.removeEventListener('mousemove', handlePaneResizeMove)
        window.removeEventListener('mouseup', endPaneResizeDrag)
        window.removeEventListener('blur', endPaneResizeDrag)
        return
      }
      const size = drag.pendingSize
      drag.sentSize = size
      void api.panes.resize(drag.paneId, drag.axis === 'x' ? { cols: size } : { rows: size }).catch(() => {}).finally(() => {
        void loadSessionSnapshot(true)
      })
      paneResizeDrag = null
      container.style.cursor = ''
      window.removeEventListener('mousemove', handlePaneResizeMove)
      window.removeEventListener('mouseup', endPaneResizeDrag)
      window.removeEventListener('blur', endPaneResizeDrag)
      window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'tmux-pane-resize' } }))
      setTimeout(() => void loadSessionSnapshot(true), 80)
    }
    const handlePaneResizeStart = (event: MouseEvent) => {
      const target = getPaneResizeTarget(event)
      if (!target) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      pointerSyncActive = false
      selectionSync.clearCopySelectionTimer()
      try {
        terminal?.clearSelection?.()
      } catch {}
      paneResizeDrag = { ...target, pendingSize: target.startSize, sentSize: target.startSize, released: false }
      container.style.cursor = target.axis === 'x' ? 'col-resize' : 'row-resize'
      window.addEventListener('mousemove', handlePaneResizeMove)
      window.addEventListener('mouseup', endPaneResizeDrag)
      window.addEventListener('blur', endPaneResizeDrag)
    }
    const handlePaneResizeHover = (event: MouseEvent) => {
      if (paneResizeDrag) return
      const now = performance.now()
      if (now - paneResizeHoverThrottle < 50) return
      paneResizeHoverThrottle = now
      const target = getPaneResizeTarget(event)
      container.style.cursor = target ? target.axis === 'x' ? 'col-resize' : 'row-resize' : ''
    }
    const clearPaneResizeHover = () => {
      if (!paneResizeDrag) container.style.cursor = ''
    }
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
      terminal.options.lineHeight = attachExclusiveRef.current && isMobileDevice ? exclusiveLineHeightRef.current : 1
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
    const adjustExclusiveLineHeight = () => {
      if (!attachExclusiveRef.current || !terminal) return false
      const screen = terminal.element?.querySelector('.xterm-screen') as HTMLElement | null
      if (!screen) return false
      const available = getAvailableSize()
      const currentHeight = screen.getBoundingClientRect().height
      if (!available.height || !currentHeight) return false
      const min = isMobileDevice ? 1 : 0.98
      const max = isMobileDevice ? 1.08 : 1.04
      const next = Math.max(min, Math.min(max, Number((exclusiveLineHeightRef.current * available.height / currentHeight).toFixed(4))))
      if (Math.abs(next - exclusiveLineHeightRef.current) < 0.001) return false
      exclusiveLineHeightRef.current = next
      terminal.options.lineHeight = next
      return true
    }
    afterTerminalWriteRef.current = () => {
      if (!attachExclusiveRef.current && isMobileDevice) requestAnimationFrame(syncSharedViewport)
    }
    const doFit = (force = false) => {
      if (!fitAddon || !terminal || disposed) return false
      if (!attachExclusiveRef.current) return false
      try {
        const stickToBottom = isMobileDevice && !isTerminalScrolledBack()
        const currentWidth = container.clientWidth
        const currentHeight = container.clientHeight
        recordMobileDebug('terminal-fit', { force, width: currentWidth, height: currentHeight })
        if (!force && Math.abs(currentWidth - lastFitSize.width) <= MOBILE_FIT_SIZE_TOLERANCE && Math.abs(currentHeight - lastFitSize.height) <= MOBILE_FIT_SIZE_TOLERANCE && lastSizeRef.current) {
          recordMobileDebug('terminal-fit-noop', { width: currentWidth, height: currentHeight })
          return true
        }
        lastFitSize = { width: currentWidth, height: currentHeight }
        applyTerminalOptions()
        fitAddon.fit()
        const size = getFitDimensions()
        if (!size) return false
        const { cols, rows } = size
        if (cols && rows && cols > 0 && rows > 0) {
          if (terminal.cols !== cols || terminal.rows !== rows) {
            terminal.resize(cols, rows)
          }
          const prev = lastSizeRef.current
          if (!prev || prev.cols !== cols || prev.rows !== rows) {
            lastSizeRef.current = { cols, rows }
            onResizeRef.current?.(cols, rows)
          }
          requestAnimationFrame(() => {
            if (disposed || !terminal) return
            scheduleRendererStyleCorrection()
            syncExclusiveViewport()
            repaintTerminalRenderer(force && isMobileDevice, stickToBottom)
            if (adjustExclusiveLineHeight()) scheduleFit(0, true)
          })
          notifyReady()
          return true
        }
      } catch (e) {
      }
      return false
    }
    const scheduleFit = (delay = 0, force = false) => {
      if (disposed) return
      if (isMobileDevice && !force) {
        const width = container.clientWidth
        const height = container.clientHeight
        if (Math.abs(width - pendingFitSize.width) <= MOBILE_FIT_SIZE_TOLERANCE && Math.abs(height - pendingFitSize.height) <= MOBILE_FIT_SIZE_TOLERANCE && lastSizeRef.current) return
        pendingFitSize = { width, height }
        if (fitTimeout) clearTimeout(fitTimeout)
        if (fitFrame) cancelAnimationFrame(fitFrame)
        fitTimeout = setTimeout(() => {
          fitTimeout = null
          doFit(false)
        }, Math.max(delay, MOBILE_FIT_DEBOUNCE_MS))
        return
      }
      if (fitTimeout) {
        clearTimeout(fitTimeout)
        fitTimeout = null
      }
      if (fitFrame) cancelAnimationFrame(fitFrame)
      if (delay > 0) {
        fitTimeout = setTimeout(() => {
          fitTimeout = null
          if (!doFit(force) && force) scheduleFit(isMobileDevice ? 32 : 0, true)
        }, delay)
        return
      }
      fitFrame = requestAnimationFrame(() => {
        fitFrame = null
        doFit(force)
      })
    }
    const scheduleInitialFit = () => {
      if (disposed) return
      if (fitFrame) cancelAnimationFrame(fitFrame)
      if (fitTimeout) clearTimeout(fitTimeout)
      fitTimeout = setTimeout(() => {
        fitTimeout = null
        scheduleFit(0, !isMobileDevice)
      }, isMobileDevice ? 80 : 0)
    }
    const forceStableFit = (attempts = attachExclusiveRef.current ? 6 : 4, interval = 34) => {
      if (disposed) return
      stableFitToken += 1
      const token = stableFitToken
      let remaining = Math.max(1, attempts)
      const run = () => {
        if (disposed || token !== stableFitToken) return
        if (attachExclusiveRef.current) {
          scheduleFit(isMobileDevice ? MOBILE_FIT_DEBOUNCE_MS : 0, !isMobileDevice)
        } else {
          syncSharedLayout(true)
        }
        remaining -= 1
        if (remaining <= 0) return
        stableFitTimer = setTimeout(run, interval)
      }
      if (stableFitTimer) clearTimeout(stableFitTimer)
      run()
    }
    scheduleFitRef.current = scheduleFit
    forceStableFitRef.current = () => forceStableFit()

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
        if (!prev || prev.cols !== size.cols || prev.rows !== size.rows) {
          onResizeRef.current?.(size.cols, size.rows)
        }
      })
    }
    syncSharedLayoutRef.current = (rf) => syncSharedLayout(rf)

    const initTerminal = async () => {
      const { Terminal } = await import('@xterm/xterm')
      const { FitAddon } = await import('@xterm/addon-fit')
      const { WebLinksAddon } = await import('@xterm/addon-web-links')
      const { Unicode11Addon } = await import('@xterm/addon-unicode11')
      if (!container || !container.isConnected || disposed) return
      const style = getComputedStyle(document.documentElement)
      const getVar = (name: string) => style.getPropertyValue(name).trim()
      terminal = new Terminal({
        theme: {
          background: `rgb(${getVar('--bg-1')})`,
          foreground: `rgb(${getVar('--text-1')})`,
          cursor: `rgb(${getVar('--accent')})`,
          selectionBackground: `rgb(${getVar('--accent')} / 0.2)`,
        },
        cursorBlink: preferencesRef.current.cursorBlink,
        cursorStyle: 'bar',
        allowTransparency: false,
        fontSize: preferencesRef.current.fontSize,
        fontFamily: preferencesRef.current.fontFamily,
        fontWeight: '400',
        fontWeightBold: '700',
        letterSpacing: 0,
        lineHeight: 1,
        minimumContrastRatio: 4.5,
        customGlyphs: true,
        allowProposedApi: true,
        macOptionIsMeta: true,
        macOptionClickForcesSelection: true,
        scrollback: SCROLLBACK_LIMIT,
      })

      fitAddon = new FitAddon()
      terminal.loadAddon(new Unicode11Addon())
      terminal.unicode.activeVersion = '11'
      terminal.loadAddon(fitAddon)
      terminal.loadAddon(new WebLinksAddon((event: MouseEvent, uri: string) => {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation?.()
        if (!isLinkOpenGesture(event)) return
        openUrlInNewWindow(uri, pushToast, tRef.current)
      }))
      terminal.open(container)
      disposables.push(terminal.registerLinkProvider({
        provideLinks: (bufferLineNumber: number, callback: (links: any[] | undefined) => void) => {
          const links = createTerminalFileLinks(bufferLineNumber)
          callback(links.length ? links : undefined)
        },
      }))
      let rendererType:'dom'|'webgl' = 'dom'
      if (!isMobileDevice) {
        try {
          const { WebglAddon } = await import('@xterm/addon-webgl')
          terminal.loadAddon(new WebglAddon())
          rendererType = 'webgl'
        } catch {}
      }
      recordMobileDebug('terminal-renderer', { renderer: rendererType })
      if (terminal.element instanceof HTMLElement) {
        terminal.element.style.width = '100%'
        terminal.element.style.height = '100%'
        terminal.element.style.display = 'block'
        const screen = terminal.element.querySelector('.xterm-screen') as HTMLElement | null
        const viewport = terminal.element.querySelector('.xterm-viewport') as HTMLElement | null
        if (screen) {
          screen.style.position = 'absolute'
          screen.style.inset = '0'
          screen.style.width = '100%'
          screen.style.height = '100%'
        }
        if (viewport) {
          viewport.style.width = '100%'
          viewport.style.height = '100%'
          viewport.style.overflow = 'hidden'
          viewport.style.background = 'transparent'
          viewport.style.scrollbarWidth = 'none'
          viewport.style.setProperty('-ms-overflow-style', 'none')
        }
        scheduleRendererStyleCorrection()
      }
      fitAddonRef.current = fitAddon
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
      if (attachExclusiveRef.current) {
        scheduleInitialFit()
      }
      disposables.push(
        terminal.onData((data: string) => {
          onInputRef.current?.(data)
        })
      )
      terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        recordImeDebug('custom-key-handler', { key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, keyCode: e.keyCode, isComposing: e.isComposing })
        if (isImeKeyEvent(e)) return true
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'c') {
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
        if (e.key === 'Backspace' && e.ctrlKey && !e.metaKey && !e.altKey) {
          if (e.repeat || deleteWordRepeatActive) return false
          onInputRef.current?.(DELETE_PREV_WORD_SEQUENCE)
          startDeleteWordRepeat()
          return false
        }
        if (e.key === 'Delete' && e.ctrlKey && !e.metaKey && !e.altKey) {
          onInputRef.current?.(DELETE_NEXT_WORD_SEQUENCE)
          return false
        }
        if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          onInputRef.current?.('\u001b[3~')
          return false
        }
        return true
      })
      disposables.push(terminal.onSelectionChange(() => {
        const selection = getSelectionText()
        selectionSync.setSelection(selection)
      }))
      const flushWriteBuffer = () => {
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
        if (pointerSyncActive) {
          writeBuffer += raw
          if (!writePending) {
            writePending = true
            requestAnimationFrame(flushWriteBuffer)
          }
          return
        }
        pushTerminalOutput(raw)
      }
      const unsubscribeOutput = subscribeOutputRef.current ? subscribeOutputRef.current(handleOutput) : () => {}
      if (!subscribeOutputRef.current) window.addEventListener('tmuxgo-terminal-output', handleOutput as EventListener)
      const handleCopySelection = (event: Event) => {
        const selection = getSelectionText()
        window.dispatchEvent(new CustomEvent('tmuxgo-terminal-selection', { detail: { requestId: (event as CustomEvent).detail?.requestId, selection } }))
      }
      window.addEventListener('tmuxgo-copy-terminal-selection', handleCopySelection as EventListener)
      const handleWindowResize = () => {
        syncRenderEnvironment('window-resize')
        if (!attachExclusiveRef.current) {
          syncSharedLayout(false)
          return
        }
        scheduleFit(isMobileDevice ? MOBILE_FIT_DEBOUNCE_MS : 0)
      }
      const handleKeyUp = (e: KeyboardEvent) => {
        recordImeDebug('window-keyup', { key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, isComposing: e.isComposing })
        if (e.key === 'Backspace' || !e.ctrlKey) stopDeleteWordRepeat()
      }
      const handleOrientationChange = () => {
        if (attachExclusiveRef.current) {
          scheduleFit(0, true)
          setTimeout(() => scheduleFit(0, true), 120)
        } else {
          syncSharedLayout(true)
          setTimeout(() => syncSharedLayout(true), 120)
        }
        recoverTerminalScreen('orientationchange', true)
        setTimeout(() => recoverTerminalScreen('orientationchange-stable'), 140)
      }
      const handleKeyboardChange = (event: Event) => {
        const detail = (event as CustomEvent<{ open?: boolean }>).detail
        const nextOpen = typeof detail?.open === 'boolean' ? detail.open : document.body.classList.contains('keyboard-open')
        if (nextOpen === lastKeyboardOpen) return
        lastKeyboardOpen = nextOpen
        if (isMobileDevice) cancelTmuxCopyMode()
        if (!attachExclusiveRef.current) return
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
        void loadSessionSnapshot()
        if (attachExclusiveRef.current) {
          scheduleInitialFit()
          if (!isMobileDevice) forceStableFit(5, 34)
          if (softRecover) scheduleTerminalRepaint(isMobileDevice ? MOBILE_TERMINAL_REPAINT_DELAYS : TERMINAL_REPAINT_DELAYS)
          else softRecoverTerminalScreen('attached', true)
          return
        }
        if (cols > 0 && rows > 0) {
          sharedSessionSizeRef.current = { cols, rows }
          syncSharedLayout(true)
          if (!isMobileDevice) forceStableFit(4, 34)
          if (softRecover) scheduleTerminalRepaint(isMobileDevice ? MOBILE_TERMINAL_REPAINT_DELAYS : TERMINAL_REPAINT_DELAYS)
          else softRecoverTerminalScreen('attached', true)
        }
      }
      const handleLayoutChange = (event: Event) => {
        const detail = (event as CustomEvent).detail || {}
        if (isMobileDevice && detail.reason === 'attached') return
        const mobileKeyboardLayout = isMobileDevice && (detail.reason === 'viewport-sync' || detail.reason === 'mobile-keyboard-dock')
        const stickToBottom = isMobileDevice && !isTerminalScrolledBack()
        const perf = useConsoleStore.getState().terminalPerf || DEFAULT_TERMINAL_PERF
        updateTerminalPerf({ layoutFitCount: perf.layoutFitCount + 1 })
        if (detail.reason === 'terminal-panel-resize') {
          if (!isMobileDevice) {
            if (attachExclusiveRef.current) scheduleFit(0, false)
            else syncSharedLayout(false)
            return
          }
          if (attachExclusiveRef.current) {
            scheduleFit(0, true)
            scheduleTerminalRepaint([0, 16, 48])
            return
          }
          syncSharedLayout(true)
          scheduleTerminalRepaint([0, 16, 48])
          return
        }
        if (detail.reason === 'terminal-panel-resize-end') {
          if (attachExclusiveRef.current) {
            if (isMobileDevice) scheduleFit(0, true)
            else forceStableFit(3, 24)
            scheduleTerminalRepaint([0, 16, 48])
            return
          }
          syncSharedLayout(true)
          if (!isMobileDevice) forceStableFit(2, 24)
          scheduleTerminalRepaint([0, 16, 48])
          return
        }
        if (attachExclusiveRef.current) {
          if (isMobileDevice) scheduleFit(mobileKeyboardLayout ? 0 : MOBILE_FIT_DEBOUNCE_MS, mobileKeyboardLayout)
          else forceStableFit(5, 34)
          scheduleTerminalRepaint(mobileKeyboardLayout ? MOBILE_TERMINAL_KEYBOARD_REPAINT_DELAYS : isMobileDevice ? MOBILE_TERMINAL_REPAINT_DELAYS : TERMINAL_REPAINT_DELAYS, false, stickToBottom, mobileKeyboardLayout)
          return
        }
        if (!isMobileDevice) forceStableFit(4, 34)
        scheduleTerminalRepaint(mobileKeyboardLayout ? MOBILE_TERMINAL_KEYBOARD_REPAINT_DELAYS : isMobileDevice ? MOBILE_TERMINAL_REPAINT_DELAYS : TERMINAL_REPAINT_DELAYS, false, stickToBottom, mobileKeyboardLayout)
      }
      const handleVisibilityChange = () => {
        if (document.hidden) {
          stopDeleteWordRepeat()
          return
        }
        const recovered = syncRenderEnvironment('visibilitychange')
        if (attachExclusiveRef.current) {
          if (isMobileDevice) scheduleFit(MOBILE_FIT_DEBOUNCE_MS)
          else forceStableFit(4, 34)
          if (isMobileDevice && !recovered) {
            recoverTerminalScreen('visibilitychange')
            return
          }
          if (recovered) return
          scheduleTerminalRepaint(isMobileDevice ? MOBILE_TERMINAL_REPAINT_DELAYS : TERMINAL_REPAINT_DELAYS)
          return
        }
        if (!isMobileDevice) forceStableFit(3, 34)
        if (isMobileDevice && !recovered) {
          recoverTerminalScreen('visibilitychange')
          return
        }
        if (recovered) return
        scheduleTerminalRepaint(isMobileDevice ? MOBILE_TERMINAL_REPAINT_DELAYS : TERMINAL_REPAINT_DELAYS)
      }
      const handlePageShow = () => {
        const recovered = syncRenderEnvironment('pageshow')
        if (attachExclusiveRef.current) scheduleFit(isMobileDevice ? MOBILE_FIT_DEBOUNCE_MS : 0, true)
        if (isMobileDevice && !recovered) recoverTerminalScreen('pageshow')
      }
      window.addEventListener('tmux-attached', handleAttached as EventListener)
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
      container.addEventListener('mousedown', handlePaneResizeStart, true)
      container.addEventListener('mousemove', handlePaneResizeHover)
      container.addEventListener('mouseleave', clearPaneResizeHover)
      container.addEventListener('dragover', dropState.handleDragOver)
      container.addEventListener('dragleave', handleDragLeave)
      container.addEventListener('drop', dropState.handleDrop)
      const handleCopy = (e: ClipboardEvent) => {
        selectionSync.handleNativeCopyEvent(getSelectionText(), e)
      }
      helperTextarea = terminal.textarea
      helperTextarea?.addEventListener('copy', handleCopy, true)
      container.addEventListener('copy', handleCopy, true)
      const handleHelperCompositionStart = () => {
        helperTextareaComposing = true
        recordImeDebug('helper-compositionstart', { value: helperTextarea?.value || '' })
      }
      const handleHelperCompositionEnd = () => {
        helperTextareaComposing = false
        recordImeDebug('helper-compositionend', { value: helperTextarea?.value || '' })
      }
      const handleHelperCompositionUpdate = (event: CompositionEvent) => {
        recordImeDebug('helper-compositionupdate', { data: event.data || '', value: helperTextarea?.value || '' })
      }
      const handleHelperFocus = () => {
        recordImeDebug('helper-focus', { value: helperTextarea?.value || '' })
      }
      const handleHelperBlur = () => {
        recordImeDebug('helper-blur', { value: helperTextarea?.value || '' })
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
      helperTextarea?.addEventListener('compositionstart', handleHelperCompositionStart)
      helperTextarea?.addEventListener('compositionupdate', handleHelperCompositionUpdate)
      helperTextarea?.addEventListener('compositionend', handleHelperCompositionEnd)
      helperTextarea?.addEventListener('focus', handleHelperFocus)
      helperTextarea?.addEventListener('blur', handleHelperBlur)
      helperTextarea?.addEventListener('beforeinput', handleHelperBeforeInput as EventListener, true)
      helperTextarea?.addEventListener('input', handleHelperInput as EventListener, true)
      helperTextarea?.addEventListener('keydown', handleHelperKeyDown, true)
      helperTextarea?.addEventListener('keyup', handleHelperKeyUp, true)
      helperTextarea?.addEventListener('paste', pasteBridge.handlePaste, true)
      container.addEventListener('paste', pasteBridge.handlePaste, true)
      container.addEventListener('beforeinput', pasteBridge.handlePasteInput as EventListener, true)
      container.addEventListener('input', pasteBridge.handlePasteInput as EventListener, true)
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
        focusTerminalInput()
        requestAnimationFrame(focusTerminalInput)
        setTimeout(focusTerminalInput, 0)
        setTimeout(focusTerminalInput, 32)
        setTimeout(focusTerminalInput, 96)
      }
      container.addEventListener('mousedown', armPointerSync)
      container.addEventListener('touchstart', armPointerSync, { passive: true })
      window.addEventListener('mouseup', handlePointerSync)
      window.addEventListener('touchend', handlePointerSync)
      window.addEventListener('touchcancel', clearPointerSync)
      window.addEventListener('pointercancel', clearPointerSync)
      window.addEventListener('blur', clearPointerSync)
      window.addEventListener('tmuxgo-focus-terminal', handleFocusTerminal as EventListener)
      disposables.push({
        dispose: () => {
          window.removeEventListener('tmux-attached', handleAttached as EventListener)
          window.removeEventListener('tmuxgo-layout-change', handleLayoutChange as EventListener)
          unsubscribeOutput()
          if (!subscribeOutputRef.current) window.removeEventListener('tmuxgo-terminal-output', handleOutput as EventListener)
          window.removeEventListener('tmuxgo-copy-terminal-selection', handleCopySelection as EventListener)
          window.removeEventListener('resize', handleWindowResize)
          window.removeEventListener('keyup', handleKeyUp)
          window.removeEventListener('blur', stopDeleteWordRepeat)
          window.removeEventListener('orientationchange', handleOrientationChange)
          window.removeEventListener('mobile-keyboard-change', handleKeyboardChange as EventListener)
          window.removeEventListener('pageshow', handlePageShow)
          document.removeEventListener('visibilitychange', handleVisibilityChange)
          paneResizeDrag = null
          container.style.cursor = ''
          window.removeEventListener('mousemove', handlePaneResizeMove)
          window.removeEventListener('mouseup', endPaneResizeDrag)
          window.removeEventListener('blur', endPaneResizeDrag)
          container.removeEventListener('mousedown', handlePaneResizeStart, true)
          container.removeEventListener('mousemove', handlePaneResizeHover)
          container.removeEventListener('mouseleave', clearPaneResizeHover)
          container.removeEventListener('dragover', dropState.handleDragOver)
          container.removeEventListener('dragleave', handleDragLeave)
          container.removeEventListener('drop', dropState.handleDrop)
          helperTextarea?.removeEventListener('copy', handleCopy, true)
          container.removeEventListener('copy', handleCopy, true)
          helperTextarea?.removeEventListener('compositionstart', handleHelperCompositionStart)
          helperTextarea?.removeEventListener('compositionupdate', handleHelperCompositionUpdate)
          helperTextarea?.removeEventListener('compositionend', handleHelperCompositionEnd)
          helperTextarea?.removeEventListener('focus', handleHelperFocus)
          helperTextarea?.removeEventListener('blur', handleHelperBlur)
          helperTextarea?.removeEventListener('beforeinput', handleHelperBeforeInput as EventListener, true)
          helperTextarea?.removeEventListener('input', handleHelperInput as EventListener, true)
          helperTextarea?.removeEventListener('keydown', handleHelperKeyDown, true)
          helperTextarea?.removeEventListener('keyup', handleHelperKeyUp, true)
          helperTextarea?.removeEventListener('paste', pasteBridge.handlePaste, true)
          container.removeEventListener('paste', pasteBridge.handlePaste, true)
          container.removeEventListener('beforeinput', pasteBridge.handlePasteInput as EventListener, true)
          container.removeEventListener('input', pasteBridge.handlePasteInput as EventListener, true)
          container.removeEventListener('mousedown', armPointerSync)
          container.removeEventListener('touchstart', armPointerSync)
          window.removeEventListener('mouseup', handlePointerSync)
          window.removeEventListener('touchend', handlePointerSync)
          window.removeEventListener('touchcancel', clearPointerSync)
          window.removeEventListener('pointercancel', clearPointerSync)
          window.removeEventListener('blur', clearPointerSync)
          window.removeEventListener('tmuxgo-focus-terminal', handleFocusTerminal as EventListener)
          selectionSync.clearCopySelectionTimer()
          pasteBridge.dispose()
          selectionSync.dispose()
        },
      })
      resizeObserver = new ResizeObserver(() => {
        const width = container.clientWidth
        const height = container.clientHeight
        recordMobileDebug('terminal-resize-observer', { width, height })
        if (Math.abs(width - lastContainerSize.width) <= MOBILE_FIT_SIZE_TOLERANCE && Math.abs(height - lastContainerSize.height) <= MOBILE_FIT_SIZE_TOLERANCE) return
        lastContainerSize = { width, height }
        if (attachExclusiveRef.current) {
          if (isMobileDevice) { doFit(true); return }
          scheduleFit(0)
          return
        }
        syncSharedLayout(false)
      })
      resizeObserver.observe(container)
      container.addEventListener('touchstart', handlePinchTouchStart, { passive: true })
      container.addEventListener('touchmove', handlePinchTouchMove, { passive: false })
      container.addEventListener('touchend', handlePinchTouchEnd, { passive: true })
      container.addEventListener('touchcancel', handlePinchTouchCancel, { passive: true })
      container.addEventListener('touchstart', touchScroll.handleTouchStart, { passive: true })
      container.addEventListener('touchmove', touchScroll.handleTouchMove, { passive: false })
      container.addEventListener('touchend', touchScroll.handleTouchEnd, { passive: true })
      container.addEventListener('touchcancel', touchScroll.handleTouchCancel, { passive: true })
      disposables.push({
        dispose: () => {
          container.removeEventListener('touchstart', handlePinchTouchStart)
          container.removeEventListener('touchmove', handlePinchTouchMove)
          container.removeEventListener('touchend', handlePinchTouchEnd)
          container.removeEventListener('touchcancel', handlePinchTouchCancel)
          touchScroll.dispose()
          container.removeEventListener('touchstart', touchScroll.handleTouchStart)
          container.removeEventListener('touchmove', touchScroll.handleTouchMove)
          container.removeEventListener('touchend', touchScroll.handleTouchEnd)
          container.removeEventListener('touchcancel', touchScroll.handleTouchCancel)
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
      if (fitTimeout) clearTimeout(fitTimeout)
      if (stableFitTimer) clearTimeout(stableFitTimer)
      if (fitFrame) cancelAnimationFrame(fitFrame)
      clearTerminalRepaint()
      if (sharedLayoutFrame) cancelAnimationFrame(sharedLayoutFrame)
      afterTerminalWriteRef.current = () => {}
      disposeTerminalOutput()
      resizeObserver?.disconnect()
      disposables.forEach((d) => d?.dispose?.())
      terminal?.dispose()
      terminalInstance.current = null
      fitAddonRef.current = null
      scheduleFitRef.current = () => {}
      forceStableFitRef.current = () => {}
      syncSharedLayoutRef.current = () => {}
    }
  }, [disposeTerminalOutput, ensureFileRoots, handlePinchTouchCancel, handlePinchTouchEnd, handlePinchTouchMove, handlePinchTouchStart, openUploadDialog, pushToast, pushTerminalOutput, queryClient, selectionSync, setActivePane, syncPaneCwd, touchScroll, updateGithubDeviceLogin, updateTerminalPerf])

  return (
    <div
      ref={terminalRef}
      data-terminal
      tabIndex={0}
      className="h-full w-full min-h-0 overflow-hidden relative"
      style={{
        ['--terminal-padding' as any]: `${preferences.terminalPadding}px`,
        ['--terminal-padding-bottom' as any]: `${preferences.terminalPadding}px`,
        touchAction: isMobileDevice ? 'none' : 'auto',
      }}
      onMouseDown={() => {
        if (!isMobileDevice) terminalInstance.current?.focus?.()
      }}
      onFocus={() => {
        if (!isMobileDevice) terminalInstance.current?.focus?.()
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
      {dropState.isDropActive && <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-lg border border-dashed border-accent bg-bg-0/70 text-sm text-accent shadow-[var(--glow)]">{t('terminal.dropUpload')}</div>}
      {githubDeviceLogin && <div data-testid="github-device-login-card" className="absolute inset-x-3 bottom-3 z-20 ml-auto w-auto max-w-sm rounded-2xl border border-accent/30 bg-bg-0/92 p-3 shadow-[0_18px_48px_rgba(0,0,0,0.38)] backdrop-blur" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-text-1">{t('githubAuth.title')}</div>
            <div className="mt-1 text-xs leading-5 text-text-3">{t('githubAuth.desc')}</div>
          </div>
          <button type="button" aria-label={t('githubAuth.dismiss')} onClick={dismissGithubDeviceLogin} className="shrink-0 rounded px-1.5 py-0.5 text-text-3 transition-colors hover:bg-bg-1 hover:text-text-1">✕</button>
        </div>
        <div className="mt-3 rounded-xl border border-[var(--line)] bg-bg-1 px-3 py-2">
          <div className="text-[10px] uppercase tracking-[0.24em] text-text-3">{t('githubAuth.code')}</div>
          <div className="mt-1 font-mono text-base tracking-[0.22em] text-accent">{githubDeviceLogin.code}</div>
        </div>
        <div className="mt-3 flex gap-2">
          <button type="button" data-testid="github-device-login-open" onClick={openGithubDeviceLogin} className="flex-1 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-bg-0 transition-transform active:scale-[0.98]">{t('githubAuth.open')}</button>
          <button type="button" data-testid="github-device-login-copy" onClick={() => void copyGithubDeviceLogin()} className="flex-1 rounded-lg border border-[var(--line)] bg-bg-1 px-3 py-2 text-sm text-text-2 transition-transform active:scale-[0.98]">{t('githubAuth.copy')}</button>
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
