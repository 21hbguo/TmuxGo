'use client'

import { useEffect, useRef, useCallback } from 'react'
import { recordMobileDiagnostic } from '@/lib/mobile-diagnostics'

const SENTINEL = '\u200b\u200b'
const SENTINEL_CENTER = 1
const KEYBOARD_OPEN_THRESHOLD = 120
const KEYBOARD_CLOSE_THRESHOLD = 70
const KEYBOARD_VIEWPORT_GRACE_MS = 1500
const KEYBOARD_PROBE_MS = 700
const KEYBOARD_VERIFY_MS = 360
const DEFERRED_INPUT_COMMIT_MS = 650
const KEYBOARD_EVENT = 'mobile-keyboard-change'
const isEdgeAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent) && /EdgA/i.test(navigator.userAgent)
function isImeKeyEvent(e: KeyboardEvent) {
  return e.isComposing || e.key === 'Process' || e.keyCode === 229 || e.which === 229
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

export function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false
  const ua = navigator.userAgent || ''
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches
  const desktopPlatform = /Windows NT|Macintosh|X11|Linux x86_64|Linux i[3-6]86/i.test(ua)
  return coarsePointer && !desktopPlatform
}

export function useMobileKeyboard(
  sendInput: (data: string) => void,
  terminalRef: React.RefObject<HTMLDivElement | null>,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const composingRef = useRef(false)
  const composingLengthRef = useRef(0)
  const keyboardOpenRef = useRef(false)
  const keyboardInsetRef = useRef(0)
  const keyboardPeakInsetRef = useRef(0)
  const focusingRef = useRef(false)
  const keyboardProbeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const keyboardVerifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const deferredInputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const deferredInputActiveRef = useRef(false)
  const keepAliveUntilRef = useRef(0)
  const viewportGraceUntilRef = useRef(0)
  const viewportBaseHeightRef = useRef(0)
  const isMobile = useRef(isMobileDevice())
  const keyboardLog = useCallback((event: string, data?: unknown) => {
    if (isEdgeAndroid) console.debug('[mobile-keyboard]', event, data || '')
  }, [])
  const getViewportInset = useCallback(() => {
    const vv = window.visualViewport
    if (!vv) return 0
    const currentHeight = vv.height
    if (currentHeight > viewportBaseHeightRef.current) viewportBaseHeightRef.current = currentHeight
    return Math.max(0, viewportBaseHeightRef.current - currentHeight)
  }, [])
  const emitKeyboardChange = useCallback((open: boolean, inset: number) => {
    window.dispatchEvent(new CustomEvent(KEYBOARD_EVENT, { detail: { open, inset } }))
  }, [])
  const clearKeyboardProbe = useCallback(() => {
    if (!keyboardProbeTimerRef.current) return
    clearTimeout(keyboardProbeTimerRef.current)
    keyboardProbeTimerRef.current = null
  }, [])
  const clearKeyboardVerify = useCallback(() => {
    if (!keyboardVerifyTimerRef.current) return
    clearTimeout(keyboardVerifyTimerRef.current)
    keyboardVerifyTimerRef.current = null
  }, [])
  const getVirtualKeyboardInset = useCallback(() => {
    const virtualKeyboard = (navigator as any).virtualKeyboard
    return Math.max(0, virtualKeyboard?.boundingRect?.height || 0)
  }, [])
  const getObservedKeyboardInset = useCallback(() => {
    const virtualInset = getVirtualKeyboardInset()
    return virtualInset > 0 ? virtualInset : getViewportInset()
  }, [getViewportInset, getVirtualKeyboardInset])
  const closeKeyboard = useCallback((blurInput = false) => {
    clearKeyboardProbe()
    clearKeyboardVerify()
    const shouldEmitClose = keyboardOpenRef.current || keyboardInsetRef.current > 0 || keyboardPeakInsetRef.current > 0 || document.body.classList.contains('keyboard-open')
    if (shouldEmitClose) recordMobileDebug('keyboard-close', { blurInput })
    keyboardOpenRef.current = false
    keyboardInsetRef.current = 0
    keyboardPeakInsetRef.current = 0
    keepAliveUntilRef.current = 0
    viewportGraceUntilRef.current = 0
    if (shouldEmitClose) keyboardLog('close')
    document.body.classList.remove('keyboard-open')
    document.documentElement.style.setProperty('--mobile-keyboard-inset', '0px')
    if (blurInput && document.activeElement === textareaRef.current) textareaRef.current?.blur()
    if (shouldEmitClose) emitKeyboardChange(false, 0)
  }, [clearKeyboardProbe, clearKeyboardVerify, emitKeyboardChange, keyboardLog])
  const scheduleKeyboardVerify = useCallback(() => {
    clearKeyboardVerify()
    keyboardVerifyTimerRef.current = setTimeout(() => {
      keyboardVerifyTimerRef.current = null
      if (!keyboardOpenRef.current) return
      const inset = getObservedKeyboardInset()
      const peakInset = Math.max(keyboardPeakInsetRef.current, keyboardInsetRef.current)
      const recoveredEnough = inset <= KEYBOARD_CLOSE_THRESHOLD || (peakInset > 0 && (inset <= peakInset * 0.6 || peakInset - inset >= 100))
      if (recoveredEnough && Date.now() > keepAliveUntilRef.current) {
        closeKeyboard(true)
        return
      }
      scheduleKeyboardVerify()
    }, KEYBOARD_VERIFY_MS)
  }, [clearKeyboardVerify, closeKeyboard, getObservedKeyboardInset])
  const openKeyboard = useCallback((inset: number) => {
    keyboardLog('open', inset)
    recordMobileDebug('keyboard-open', { inset })
    document.body.classList.add('keyboard-open')
    const clamped = Math.max(KEYBOARD_OPEN_THRESHOLD, inset)
    const changed = !keyboardOpenRef.current || Math.abs(clamped - keyboardInsetRef.current) >= 1
    keyboardOpenRef.current = true
    keyboardInsetRef.current = clamped
    keyboardPeakInsetRef.current = Math.max(keyboardPeakInsetRef.current, clamped)
    document.documentElement.style.setProperty('--mobile-keyboard-inset', `${clamped}px`)
    scheduleKeyboardVerify()
    if (changed) emitKeyboardChange(true, clamped)
  }, [emitKeyboardChange, keyboardLog, scheduleKeyboardVerify])
  const updateKeyboardInset = useCallback((inset: number) => {
    if (!keyboardOpenRef.current || Math.abs(inset - keyboardInsetRef.current) < 1) return
    keyboardInsetRef.current = inset
    keyboardPeakInsetRef.current = Math.max(keyboardPeakInsetRef.current, inset)
    document.documentElement.style.setProperty('--mobile-keyboard-inset', `${inset}px`)
    scheduleKeyboardVerify()
    emitKeyboardChange(true, inset)
  }, [emitKeyboardChange, scheduleKeyboardVerify])
  const isKeyboardOwnerActive = useCallback(() => {
    const ta = textareaRef.current
    return !!ta && (document.activeElement === ta || Date.now() <= keepAliveUntilRef.current || (keyboardOpenRef.current && Date.now() <= viewportGraceUntilRef.current))
  }, [])

  const clearValue = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.value = SENTINEL
    try { ta.setSelectionRange(SENTINEL_CENTER, SENTINEL_CENTER) } catch {}
  }, [])
  const getInputText = useCallback(() => textareaRef.current?.value.replace(/\u200b/g, '') || '', [])
  const clearDeferredInputTimer = useCallback(() => {
    if (!deferredInputTimerRef.current) return
    clearTimeout(deferredInputTimerRef.current)
    deferredInputTimerRef.current = null
  }, [])
  const flushDeferredInput = useCallback(() => {
    clearDeferredInputTimer()
    const text = getInputText()
    deferredInputActiveRef.current = false
    if (text) sendInput(text)
    clearValue()
  }, [clearDeferredInputTimer, clearValue, getInputText, sendInput])
  const scheduleDeferredInputFlush = useCallback(() => {
    clearDeferredInputTimer()
    deferredInputActiveRef.current = true
    deferredInputTimerRef.current = setTimeout(() => {
      deferredInputTimerRef.current = null
      const text = getInputText()
      deferredInputActiveRef.current = false
      if (text) sendInput(text)
      clearValue()
    }, DEFERRED_INPUT_COMMIT_MS)
  }, [clearDeferredInputTimer, clearValue, getInputText, sendInput])
  const shouldDeferInput = useCallback((inputType?: string, text?: string | null) => inputType === 'insertCompositionText' || inputType === 'insertReplacementText' || !!text && text.length > 1, [])
  const confirmKeyboardOpen = useCallback(() => {
    const ta = textareaRef.current
    if (!ta || document.activeElement !== ta) return false
    const inset = getViewportInset()
    if (inset < KEYBOARD_OPEN_THRESHOLD) return false
    openKeyboard(inset)
    return true
  }, [getViewportInset, openKeyboard])
  const scheduleKeyboardProbe = useCallback((blurOnMiss = false) => {
    clearKeyboardProbe()
    keyboardProbeTimerRef.current = setTimeout(() => {
      keyboardProbeTimerRef.current = null
      if (confirmKeyboardOpen()) return
      if (blurOnMiss && !keyboardOpenRef.current && document.activeElement === textareaRef.current) textareaRef.current?.blur()
    }, KEYBOARD_PROBE_MS)
  }, [clearKeyboardProbe, confirmKeyboardOpen])
  const focusKeyboard = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    viewportGraceUntilRef.current = Date.now() + KEYBOARD_VIEWPORT_GRACE_MS
    focusingRef.current = true
    ta.focus({ preventScroll: true })
    focusingRef.current = false
    if (document.activeElement !== ta) return
    keyboardLog('focus')
    recordMobileDebug('keyboard-focus')
    if (!deferredInputActiveRef.current) clearValue()
    if (!confirmKeyboardOpen()) scheduleKeyboardProbe(true)
  }, [clearValue, confirmKeyboardOpen, keyboardLog, scheduleKeyboardProbe])

  useEffect(() => {
    if (!isMobile.current) return
    const ta = textareaRef.current
    if (!ta) return
    const vv = window.visualViewport
    if (vv?.height) viewportBaseHeightRef.current = vv.height
    const virtualKeyboard = (navigator as any).virtualKeyboard
    if (virtualKeyboard) {
      try {
        virtualKeyboard.overlaysContent = true
        virtualKeyboard.addEventListener?.('geometrychange', () => {
          const rect = virtualKeyboard.boundingRect
          const inset = rect?.height || 0
          keyboardLog('geometrychange', inset)
          if (inset >= KEYBOARD_OPEN_THRESHOLD) openKeyboard(inset)
          else closeKeyboard()
        })
      } catch {}
    }

    clearValue()

    const ARROW_KEYS: Record<string, string> = {
      ArrowUp: '\x1b[A',
      ArrowDown: '\x1b[B',
      ArrowRight: '\x1b[C',
      ArrowLeft: '\x1b[D',
      Home: '\x1b[H',
      End: '\x1b[F',
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (composingRef.current || isImeKeyEvent(e)) return
      if (deferredInputActiveRef.current) {
        if (e.key === 'Enter' || e.key === 'Tab' || ARROW_KEYS[e.key]) {
          e.preventDefault()
          flushDeferredInput()
          sendInput(e.key === 'Enter' ? '\r' : e.key === 'Tab' ? '\t' : ARROW_KEYS[e.key])
          clearValue()
        }
        return
      }
      if (e.key === 'Backspace') {
        e.preventDefault()
        sendInput('\x7f')
        clearValue()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        sendInput('\r')
        clearValue()
      } else if (e.key === 'Tab') {
        e.preventDefault()
        sendInput('\t')
        clearValue()
      } else if (ARROW_KEYS[e.key]) {
        e.preventDefault()
        sendInput(ARROW_KEYS[e.key])
        clearValue()
      }
    }

    const handleBeforeInput = (e: InputEvent) => {
      const inputType = e.inputType
      if (inputType === 'insertCompositionText') {
        clearDeferredInputTimer()
        deferredInputActiveRef.current = false
        composingRef.current = true
        return
      }
      if (composingRef.current || deferredInputActiveRef.current) return
      if (inputType === 'insertText' || inputType === 'insertReplacementText') {
        const text = e.data
        if (shouldDeferInput(inputType, text)) return
        if (text) {
          e.preventDefault()
          sendInput(text)
          clearValue()
        }
      } else if (inputType?.startsWith('delete')) {
        e.preventDefault()
        sendInput('\x7f')
        clearValue()
      }
    }

    const handleInput = (e: Event) => {
      const inputEvent = e as InputEvent
      const inputType = inputEvent.inputType
      const text = getInputText()
      if (inputType === 'insertCompositionText') {
        clearDeferredInputTimer()
        deferredInputActiveRef.current = false
        composingRef.current = true
        composingLengthRef.current = text.length
        return
      }
      if (composingRef.current) {
        composingLengthRef.current = text.length
        return
      }
      if (deferredInputActiveRef.current || shouldDeferInput(inputType, inputEvent.data) || inputType === 'insertText' && text.length > 1) {
        if (text) scheduleDeferredInputFlush()
        else {
          clearDeferredInputTimer()
          deferredInputActiveRef.current = false
          clearValue()
        }
        return
      }
      if (inputType === 'deleteContentBackward' || inputType === 'deleteContentForward' || inputType === 'deleteByCut' || inputType === 'deleteByDrag' || inputType === 'deleteContent') {
        sendInput('\x7f')
        clearValue()
        return
      }
      if (text) {
        sendInput(text)
      } else if (inputType?.startsWith('delete')) {
        sendInput('\x7f')
      }
      clearValue()
    }

    const handleCompositionStart = () => {
      clearDeferredInputTimer()
      deferredInputActiveRef.current = false
      composingRef.current = true
      composingLengthRef.current = 0
      if (ta) ta.value = ''
    }

    const handleCompositionUpdate = () => {
      if (ta) composingLengthRef.current = ta.value.length
    }

    const handleCompositionEnd = () => {
      composingRef.current = false
      clearDeferredInputTimer()
      deferredInputActiveRef.current = false
      const raw = ta.value
      const text = raw.replace(/\u200b/g, '')
      if (text) {
        sendInput(text)
      } else {
        const count = composingLengthRef.current
        if (count > 0) sendInput('\x7f'.repeat(count))
      }
      composingLengthRef.current = 0
      clearValue()
    }

    const handleFocus = () => {
      viewportGraceUntilRef.current = Date.now() + KEYBOARD_VIEWPORT_GRACE_MS
      if (focusingRef.current) {
        setTimeout(() => {
          if (!deferredInputActiveRef.current) clearValue()
          if (!confirmKeyboardOpen()) scheduleKeyboardProbe(true)
        }, 10)
        return
      }
      if (!confirmKeyboardOpen()) scheduleKeyboardProbe(true)
      setTimeout(() => {
        if (!deferredInputActiveRef.current) clearValue()
      }, 10)
    }
    const handleKeepAliveCapture = (e: Event) => {
      const target = e.target
      if (!(target instanceof Element)) return
      if (target.closest('input,textarea,select,[contenteditable="true"]')) return
      if (!target.closest('[data-keep-mobile-keyboard]')) return
      keepAliveUntilRef.current = Date.now() + 500
      requestAnimationFrame(() => focusKeyboard())
    }
    const handleBlur = () => {
      clearKeyboardProbe()
      if (deferredInputActiveRef.current) flushDeferredInput()
      if (Date.now() > keepAliveUntilRef.current) {
        closeKeyboard()
        return
      }
      requestAnimationFrame(() => {
        if (Date.now() <= keepAliveUntilRef.current) focusKeyboard()
      })
    }

    ta.addEventListener('keydown', handleKeyDown)
    ta.addEventListener('beforeinput', handleBeforeInput as EventListener)
    ta.addEventListener('input', handleInput)
    ta.addEventListener('compositionstart', handleCompositionStart)
    ta.addEventListener('compositionupdate', handleCompositionUpdate)
    ta.addEventListener('compositionend', handleCompositionEnd)
    ta.addEventListener('focus', handleFocus)
    ta.addEventListener('blur', handleBlur)
    document.addEventListener('pointerdown', handleKeepAliveCapture, true)
    document.addEventListener('touchstart', handleKeepAliveCapture, true)
    document.addEventListener('mousedown', handleKeepAliveCapture, true)

    return () => {
      ta.removeEventListener('keydown', handleKeyDown)
      ta.removeEventListener('beforeinput', handleBeforeInput as EventListener)
      ta.removeEventListener('input', handleInput)
      ta.removeEventListener('compositionstart', handleCompositionStart)
      ta.removeEventListener('compositionupdate', handleCompositionUpdate)
      ta.removeEventListener('compositionend', handleCompositionEnd)
      ta.removeEventListener('focus', handleFocus)
      ta.removeEventListener('blur', handleBlur)
      document.removeEventListener('pointerdown', handleKeepAliveCapture, true)
      document.removeEventListener('touchstart', handleKeepAliveCapture, true)
      document.removeEventListener('mousedown', handleKeepAliveCapture, true)
      clearDeferredInputTimer()
    }
  }, [sendInput, clearValue, focusKeyboard, closeKeyboard, confirmKeyboardOpen, scheduleKeyboardProbe, openKeyboard, keyboardLog, getInputText, flushDeferredInput, scheduleDeferredInputFlush, clearDeferredInputTimer, shouldDeferInput])

  useEffect(() => {
    if (!isMobile.current) return

    const handleViewportResize = () => {
      if (isEdgeAndroid) {
        keyboardLog('viewport-bypass')
        return
      }
      const vv = window.visualViewport
      if (!vv) return
      recordMobileDebug('keyboard-viewport-resize', { height: vv.height, baseHeight: viewportBaseHeightRef.current, active: document.activeElement === textareaRef.current, open: keyboardOpenRef.current })
      if (!isKeyboardOwnerActive() && Date.now() > keepAliveUntilRef.current) {
        if (!keyboardOpenRef.current && vv.height > viewportBaseHeightRef.current) viewportBaseHeightRef.current = vv.height
        closeKeyboard()
        return
      }
      const inset = getViewportInset()
      const isOpen = keyboardOpenRef.current
      if (!isOpen && inset >= KEYBOARD_OPEN_THRESHOLD) {
        openKeyboard(inset)
      } else if (isOpen && inset <= KEYBOARD_CLOSE_THRESHOLD) {
        if (Date.now() <= keepAliveUntilRef.current) {
          requestAnimationFrame(() => {
            if (Date.now() <= keepAliveUntilRef.current) focusKeyboard()
          })
          scheduleKeyboardVerify()
          return
        }
        closeKeyboard(true)
      } else if (isOpen) {
        updateKeyboardInset(inset)
      }
    }

    handleViewportResize()
    window.visualViewport?.addEventListener('resize', handleViewportResize)
    return () => {
      window.visualViewport?.removeEventListener('resize', handleViewportResize)
      closeKeyboard()
    }
  }, [closeKeyboard, focusKeyboard, isKeyboardOwnerActive, openKeyboard, getViewportInset, scheduleKeyboardVerify, updateKeyboardInset])

  return { textareaRef, focusKeyboard, isMobile: isMobile.current }
}
