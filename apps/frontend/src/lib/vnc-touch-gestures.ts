// 移动端触摸手势 → VNC pointer 事件适配层。
// noVNC 自带的 GestureHandler 语义固定（单指 drag 即左键拖动、pinch 映射 Ctrl+滚轮缩放），
// 与产品要求（屏幕鼠标=相对轨迹板 / 触摸屏=绝对映射，不做捏合缩放）不符，故在容器
// capture 阶段拦截 touch 事件并自行翻译成 sendPointer(x, y, mask)。
// mask 采用 RFB PointerEvent 位定义：bit0 左键 bit1 中键 bit2 右键 bit3-6 滚轮，
// 与 noVNC 内部 _handleMouseButton 的 bmask 一致；mask 不变是移动，变化是按键。
export type VncTouchMode = 'trackpad' | 'touch'

export interface VncTouchPoint {
  id: number
  clientX: number
  clientY: number
}

interface TrackedTouch {
  sx: number
  sy: number
  x: number
  y: number
  px: number
  py: number
}

export interface VncTouchAdapterHooks {
  // 是否接管触摸（仅移动布局 + RFB 存活）；false 时事件透传给 noVNC 默认手势
  active(): boolean
  mode(): VncTouchMode
  // client→element 坐标换算基准（noVNC canvas）；不在位时本次事件丢弃
  canvas(): HTMLElement | null
  // 已知远端指针位置（element 坐标）：trackpad 虚拟光标的真实值来源
  cursor(): { x: number; y: number } | null
  // element 坐标 + 完整按键掩码；move/button 分派由接入层按当前 mask 决定
  sendPointer(elX: number, elY: number, mask: number): void
  // 同步 noVNC 本地光标覆盖层位置（client 坐标），可选
  moveCursor?(clientX: number, clientY: number): void
  // 单指短按（左键点击已完成）：供调用方做"点按画布聚焦隐藏输入"之类的副作用，可选
  onTap?(): void
}

// 阈值取 client px / ms：与画布尺寸无关，矩形为 0 的测试环境也可复现
export const VNC_TAP_MAX_MS = 300
export const VNC_TAP_MOVE_PX = 14
export const VNC_DOUBLE_TAP_MS = 350
export const VNC_DOUBLE_TAP_PX = 40
export const VNC_LONG_PRESS_MS = 450
// 第二指落指窗口：超出视为两次独立手势而非双指操作
export const VNC_SECOND_FINGER_MS = 250
export const VNC_SCROLL_STEP_PX = 50

const MASK_LEFT = 0x1
const MASK_RIGHT = 0x4
const MASK_WHEEL_UP = 0x8
const MASK_WHEEL_DOWN = 0x10

const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v))

export function createVncTouchAdapter(hooks: VncTouchAdapterHooks) {
  // 当前存活触点：end 事件里 event.touches 已不含抬起指，抬指点以这里缓存为准
  const touches = new Map<number, TrackedTouch>()
  // one=单指 two=双指 off=已作废（多余落指/双指先抬一指）直到全部抬起
  let phase: 'idle' | 'one' | 'two' | 'off' = 'idle'
  let oneStartT = 0
  let oneMoved = false
  // 长按拖：静止按住 VNC_LONG_PRESS_MS 才进入拖动，期间移动超阈值即作废定时器
  let armed = false
  let longTimer: ReturnType<typeof setTimeout> | null = null
  // trackpad 虚拟光标（element 坐标）：触点只给 delta，绝对位置由适配层自己维护
  let cursorEl: { x: number; y: number } | null = null
  let twoStartT = 0
  let twoStartC = { x: 0, y: 0 }
  let twoLast = { x: 0, y: 0 }
  let twoMoved = false
  let scrollAccY = 0
  let lastTap: { t: number; elX: number; elY: number; cx: number; cy: number } | null = null

  const rectOf = () => {
    const r = hooks.canvas()?.getBoundingClientRect()
    return r && r.width > 0 && r.height > 0 ? r : null
  }
  const toElement = (clientX: number, clientY: number) => {
    const r = rectOf()
    if (!r) return null
    return { x: clamp(clientX - r.left, r.width - 1), y: clamp(clientY - r.top, r.height - 1) }
  }
  // 指针落点：trackpad 固定在虚拟光标，touch 跟随触点
  const pointerAt = (clientX: number, clientY: number) =>
    hooks.mode() === 'trackpad' ? cursorEl : toElement(clientX, clientY)
  const emit = (clientX: number, clientY: number, mask: number) => {
    const el = pointerAt(clientX, clientY)
    const r = rectOf()
    if (!el || !r) return
    if (hooks.mode() === 'trackpad') cursorEl = el
    hooks.sendPointer(el.x, el.y, mask)
    hooks.moveCursor?.(r.left + el.x, r.top + el.y)
  }
  // 一次完整按键 = 按下即抬（单击/滚轮步进共用）；滚轮 mask 不是持续态必须立刻归零
  const clickAt = (elX: number, elY: number, mask: number) => {
    hooks.sendPointer(elX, elY, mask)
    hooks.sendPointer(elX, elY, 0)
    if (hooks.mode() === 'trackpad') cursorEl = { x: elX, y: elY }
    const r = rectOf()
    if (r) hooks.moveCursor?.(r.left + elX, r.top + elY)
  }
  const releaseDrag = (clientX: number, clientY: number) => {
    if (!armed) return
    armed = false
    emit(clientX, clientY, 0)
  }
  const clearLong = () => {
    if (longTimer !== null) {
      clearTimeout(longTimer)
      longTimer = null
    }
  }
  const armLongPress = () => {
    longTimer = null
    if (phase !== 'one' || touches.size !== 1) return
    const t = touches.values().next().value!
    if (Math.hypot(t.x - t.sx, t.y - t.sy) > VNC_TAP_MOVE_PX) return
    armed = true
    emit(t.x, t.y, MASK_LEFT)
  }
  const centroid = () => {
    const [a, b] = [...touches.values()]
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  }
  const centerFallback = () => {
    const r = rectOf()
    return r ? { x: r.width / 2, y: r.height / 2 } : { x: 0, y: 0 }
  }
  const beginOne = (t: TrackedTouch) => {
    phase = 'one'
    oneStartT = Date.now()
    oneMoved = false
    if (hooks.mode() === 'trackpad') {
      // 优先对齐远端已知指针（别的输入途径可能动过），否则以画布中心起步
      cursorEl = hooks.cursor() ?? cursorEl ?? centerFallback()
    } else {
      // 触摸模式触点即坐标：落下先把指针挪到触点
      emit(t.x, t.y, 0)
    }
    clearLong()
    longTimer = setTimeout(armLongPress, VNC_LONG_PRESS_MS)
  }
  const beginTwo = () => {
    clearLong()
    phase = 'two'
    const c = centroid()
    twoStartT = Date.now()
    twoStartC = { x: c.x, y: c.y }
    twoLast = { x: c.x, y: c.y }
    twoMoved = false
    scrollAccY = 0
  }

  const tapElement = (cx: number, cy: number) => {
    // 双击吸附：连续短按落在同一 element 坐标，远端 OS 才认得出双击（沿用 noVNC 做法）
    if (
      lastTap &&
      Date.now() - lastTap.t <= VNC_DOUBLE_TAP_MS &&
      Math.hypot(cx - lastTap.cx, cy - lastTap.cy) <= VNC_DOUBLE_TAP_PX
    )
      return { x: lastTap.elX, y: lastTap.elY }
    return pointerAt(cx, cy)
  }
  const wheelStep = (cx: number, cy: number, mask: number) => {
    const el = pointerAt(cx, cy)
    if (el) clickAt(el.x, el.y, mask)
  }
  const finishGesture = (liftedCount: number) => {
    if (liftedCount === 0) return
    const remaining = touches.size - liftedCount
    if (phase === 'one') {
      clearLong()
      // 单指阶段抬起的一定是那根指，取它最后缓存位置
      const t = touches.values().next().value
      if (t && armed) {
        releaseDrag(t.x, t.y)
      } else if (t && !oneMoved && Date.now() - oneStartT <= VNC_TAP_MAX_MS) {
        const el = tapElement(t.x, t.y)
        if (el) {
          clickAt(el.x, el.y, MASK_LEFT)
          lastTap = { t: Date.now(), elX: el.x, elY: el.y, cx: t.x, cy: t.y }
          hooks.onTap?.()
        }
      }
      phase = remaining > 0 ? 'off' : 'idle'
    } else if (phase === 'two') {
      // 双指同时短按=右键：必须两指在同一个 end 事件里一起抬起；先抬一指不算，
      // 剩余指进 off 作废，防半截手势退化成单指移动
      if (liftedCount === 2 && !twoMoved && Date.now() - twoStartT <= VNC_TAP_MAX_MS) {
        const c = centroid()
        const el = pointerAt(c.x, c.y)
        if (el) clickAt(el.x, el.y, MASK_RIGHT)
      }
      phase = remaining > 0 ? 'off' : 'idle'
    }
    if (remaining <= 0) {
      phase = 'idle'
      clearLong()
      armed = false
    }
  }

  const handle = (kind: 'start' | 'move' | 'end' | 'cancel', points: VncTouchPoint[]) => {
    if (!hooks.active()) return
    if (kind === 'cancel') {
      clearLong()
      const t = touches.values().next().value
      if (t) releaseDrag(t.x, t.y)
      else armed = false
      touches.clear()
      phase = 'idle'
      return
    }
    if (kind === 'start') {
      for (const p of points) {
        if (touches.has(p.id)) continue
        touches.set(p.id, { sx: p.clientX, sy: p.clientY, x: p.clientX, y: p.clientY, px: p.clientX, py: p.clientY })
      }
      if (touches.size === 1 && phase === 'idle') {
        beginOne(touches.values().next().value!)
      } else if (touches.size === 2 && phase === 'one' && Date.now() - oneStartT <= VNC_SECOND_FINGER_MS) {
        beginTwo()
      } else if (touches.size >= 2) {
        // 第二指太迟/第三指：作废本次手势；拖动中先松键避免远端按键卡死
        clearLong()
        const t = touches.values().next().value!
        releaseDrag(t.x, t.y)
        phase = 'off'
      }
      return
    }
    for (const p of points) {
      const t = touches.get(p.id)
      if (t) {
        t.x = p.clientX
        t.y = p.clientY
      }
    }
    if (kind === 'end') {
      const lifted = [...touches.keys()].filter((id) => !points.some((p) => p.id === id))
      finishGesture(lifted.length)
      for (const id of lifted) touches.delete(id)
      return
    }
    if (phase === 'one' && touches.size === 1) {
      const t = touches.values().next().value!
      if (Math.hypot(t.x - t.sx, t.y - t.sy) > VNC_TAP_MOVE_PX) {
        oneMoved = true
        clearLong()
      }
      if (hooks.mode() === 'trackpad' && cursorEl) {
        const r = rectOf()
        cursorEl = {
          x: clamp(cursorEl.x + (t.x - t.px), (r?.width ?? 1) - 1),
          y: clamp(cursorEl.y + (t.y - t.py), (r?.height ?? 1) - 1),
        }
      }
      emit(t.x, t.y, armed ? MASK_LEFT : 0)
      t.px = t.x
      t.py = t.y
    } else if (phase === 'two' && touches.size === 2) {
      const c = centroid()
      if (Math.hypot(c.x - twoStartC.x, c.y - twoStartC.y) > VNC_TAP_MOVE_PX) twoMoved = true
      // 双指上下=滚轮：沿用 noVNC「拖内容」约定，指下滚上（0x8）指上滚下（0x10）
      scrollAccY += c.y - twoLast.y
      twoLast = { x: c.x, y: c.y }
      while (scrollAccY >= VNC_SCROLL_STEP_PX) {
        scrollAccY -= VNC_SCROLL_STEP_PX
        wheelStep(c.x, c.y, MASK_WHEEL_UP)
      }
      while (scrollAccY <= -VNC_SCROLL_STEP_PX) {
        scrollAccY += VNC_SCROLL_STEP_PX
        wheelStep(c.x, c.y, MASK_WHEEL_DOWN)
      }
    }
  }
  return { handle }
}

// DOM 接线：capture 拦截容器上的原生 touch 事件，active 时 preventDefault+stopPropagation
// 使 noVNC canvas 内的 GestureHandler 根本收不到触点；非 active 全透传不影响桌面端
export function attachVncTouchAdapter(el: HTMLElement, hooks: VncTouchAdapterHooks) {
  const adapter = createVncTouchAdapter(hooks)
  const toPoints = (list: TouchList): VncTouchPoint[] =>
    Array.from(list, (t) => ({ id: t.identifier, clientX: t.clientX, clientY: t.clientY }))
  const on = (kind: 'start' | 'move' | 'end' | 'cancel') => (ev: TouchEvent) => {
    if (!hooks.active()) return
    // 拦截即独占：preventDefault 禁掉浏览器滚动/双指缩放/click 合成，
    // stopPropagation 使事件到不了 canvas 的 noVNC 手势层
    ev.preventDefault()
    ev.stopPropagation()
    adapter.handle(kind, toPoints(ev.touches))
  }
  const onStart = on('start')
  const onMove = on('move')
  const onEnd = on('end')
  const onCancel = on('cancel')
  const opts: AddEventListenerOptions = { capture: true, passive: false }
  el.addEventListener('touchstart', onStart, opts)
  el.addEventListener('touchmove', onMove, opts)
  el.addEventListener('touchend', onEnd, opts)
  el.addEventListener('touchcancel', onCancel, opts)
  return {
    handle: adapter.handle,
    dispose: () => {
      el.removeEventListener('touchstart', onStart, opts)
      el.removeEventListener('touchmove', onMove, opts)
      el.removeEventListener('touchend', onEnd, opts)
      el.removeEventListener('touchcancel', onCancel, opts)
    },
  }
}
