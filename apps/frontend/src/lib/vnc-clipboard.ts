import { extractClipboardText, writeClipboardText } from './clipboard-text'

export interface VncClipboardRfb {
  clipboardPasteFrom: (text: string) => void
  sendKey: (keysym: number, code: string, down?: boolean) => void
}

interface HeldPaste {
  code: 'KeyV' | 'Insert'
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  timer: number
}

// RFB extended clipboard action Notify（见 @novnc/novnc rfb.js）：协商过该能力时
// clipboardPasteFrom 只发 Notify，文本要等服务端 Request→Provide 往返后才真正落地，
// 回放按键需延后，否则远端先处理 Ctrl+V 读到旧剪贴板
const EXT_CLIPBOARD_NOTIFY = 1 << 27
const EXT_REPLAY_DELAY_MS = 250
const HELD_FALLBACK_MS = 400
// 回放用 keysym：v=0x76 Insert=0xff63；修饰键 Control_L/Shift_L/Alt_L/Super_L
const PASTE_KEYSYM: Record<HeldPaste['code'], number> = { KeyV: 0x76, Insert: 0xff63 }
const MOD_KEYSYMS: Array<[key: 'ctrl' | 'shift' | 'alt' | 'meta', keysym: number, code: string]> = [
  ['ctrl', 0xffe3, 'ControlLeft'],
  ['shift', 0xffe1, 'ShiftLeft'],
  ['alt', 0xffe9, 'AltLeft'],
  ['meta', 0xffeb, 'MetaLeft'],
]

function isPasteCombo(event: KeyboardEvent) {
  return (
    (event.code === 'KeyV' && (event.ctrlKey || event.metaKey)) ||
    // Shift+Insert 是粘贴；Ctrl+Insert 是复制，不拦
    (event.code === 'Insert' && event.shiftKey && !event.ctrlKey && !event.metaKey)
  )
}

function replayPasteCombo(rfb: VncClipboardRfb, h: HeldPaste) {
  const keysym = PASTE_KEYSYM[h.code]
  for (const [mod, sym, code] of MOD_KEYSYMS) if (h[mod]) rfb.sendKey(sym, code, true)
  rfb.sendKey(keysym, h.code, true)
  rfb.sendKey(keysym, h.code, false)
  for (const [mod, sym, code] of [...MOD_KEYSYMS].reverse()) if (h[mod]) rfb.sendKey(sym, code, false)
}

/**
 * VNC 剪贴板双向透传。
 * 本地→远端：capture 拦截粘贴组合键（stopPropagation 让 noVNC 收不到，但不 preventDefault，
 * 浏览器照常派发 paste 事件），paste 事件里先同步文本再回放按键，远端粘贴时剪贴板已最新，
 * 全程无需剪贴板权限；paste 不派发的浏览器（如 Safari 对非编辑元素）退化为激活态 readText。
 * 权限已授予时 pointerdown/focus/copy 主动推送，覆盖远端右键粘贴等无本地按键路径。
 * 远端→本地：onServerClipboard 立即写系统剪贴板；被激活态/权限挡住时挂起到下一次用户手势补写。
 */
export function attachVncClipboardSync(
  container: HTMLElement,
  getRfb: () => VncClipboardRfb | null,
  isViewOnly: () => boolean,
) {
  let lastSynced = ''
  // 远端文本未真正落入系统剪贴板时的挂起值，下一次手势补写
  let pendingRemote = ''
  let held: HeldPaste | null = null

  const writeLocal = (text: string) => {
    void writeClipboardText(text).then((result) => {
      pendingRemote = result.source === 'memory' ? text : ''
    })
  }
  const flushPending = () => {
    if (pendingRemote) writeLocal(pendingRemote)
  }
  const pushRemote = (rfb: VncClipboardRfb, text: string) => {
    // 与最近同步值相同则跳过：pointerdown 主动推送和随后 paste 事件会拿到同一文本
    if (!text || text === lastSynced) return
    lastSynced = text
    rfb.clipboardPasteFrom(text)
  }
  const queueReplay = (rfb: VncClipboardRfb, h: HeldPaste) => {
    const extended = !!(rfb as { _clipboardServerCapabilitiesActions?: Record<number, boolean> })
      ._clipboardServerCapabilitiesActions?.[EXT_CLIPBOARD_NOTIFY]
    setTimeout(() => replayPasteCombo(rfb, h), extended ? EXT_REPLAY_DELAY_MS : 0)
  }
  const flushHeld = () => {
    const h = held
    held = null
    if (!h) return
    clearTimeout(h.timer)
    const rfb = getRfb()
    if (rfb) queueReplay(rfb, h)
  }
  const probeReadText = () => {
    if (!navigator.clipboard?.readText) return
    const read = () =>
      navigator.clipboard
        .readText()
        .then((text) => {
          // paste 事件先处理过就跳过；否则文本到手即推送并回放
          if (!held) return
          const rfb = getRfb()
          if (rfb) pushRemote(rfb, text)
          flushHeld()
        })
        .catch(() => {})
    const perms = navigator.permissions
    if (!perms?.query) {
      // Safari 无可用 permissions 查询：直接借本次 keydown 激活态读
      void read()
      return
    }
    void perms
      .query({ name: 'clipboard-read' as PermissionName })
      .then((perm) => {
        // 'prompt' 状态不触发授权弹窗，交给 paste 事件路径
        if (perm.state === 'granted') void read()
      })
      .catch(() => void read())
  }
  const onKeyDown = (event: KeyboardEvent) => {
    const rfb = getRfb()
    if (!rfb || isViewOnly() || !isPasteCombo(event)) return
    event.stopPropagation()
    if (held) clearTimeout(held.timer)
    held = {
      code: event.code as HeldPaste['code'],
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
      alt: event.altKey,
      meta: event.metaKey,
      // 兜底：paste/readText 都没来也要回放按键，避免吞键
      timer: window.setTimeout(flushHeld, HELD_FALLBACK_MS),
    }
    probeReadText()
  }
  const onPaste = (event: ClipboardEvent) => {
    const rfb = getRfb()
    const text = extractClipboardText(event.clipboardData)
    if (rfb && !isViewOnly() && text) {
      event.preventDefault()
      pushRemote(rfb, text)
    }
    flushHeld()
  }
  const syncFromLocal = () => {
    const rfb = getRfb()
    if (!rfb || isViewOnly() || !navigator.permissions?.query || !navigator.clipboard?.readText) return
    void navigator.permissions
      .query({ name: 'clipboard-read' as PermissionName })
      .then((perm) => (perm.state === 'granted' ? navigator.clipboard.readText() : null))
      .then((text) => {
        const current = getRfb()
        if (text && text !== lastSynced && current) pushRemote(current, text)
      })
      .catch(() => {})
  }
  const onCopy = () => setTimeout(syncFromLocal, 0)

  container.addEventListener('keydown', onKeyDown, true)
  container.addEventListener('paste', onPaste)
  container.addEventListener('pointerdown', syncFromLocal)
  document.addEventListener('copy', onCopy)
  document.addEventListener('cut', onCopy)
  // 远端→本地的挂起补写挂在 document 手势上：用户可能点回本地编辑区再 Ctrl+V
  document.addEventListener('pointerdown', flushPending, true)
  document.addEventListener('keydown', flushPending, true)
  window.addEventListener('focus', syncFromLocal)
  return {
    onServerClipboard: (text: string) => {
      lastSynced = text
      writeLocal(text)
    },
    dispose: () => {
      container.removeEventListener('keydown', onKeyDown, true)
      container.removeEventListener('paste', onPaste)
      container.removeEventListener('pointerdown', syncFromLocal)
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('cut', onCopy)
      document.removeEventListener('pointerdown', flushPending, true)
      document.removeEventListener('keydown', flushPending, true)
      window.removeEventListener('focus', syncFromLocal)
      if (held) clearTimeout(held.timer)
    },
  }
}
