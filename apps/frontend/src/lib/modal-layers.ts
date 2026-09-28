import { isImeKeyEvent } from './terminal-platform'

export interface KeyLayer {
  id: number
  onEscape?: () => void
  onEnter?: () => void
  /** 模态层的根元素；非模态层（菜单/下拉）不挂元素，只做 Esc 占位 */
  getEl?: () => HTMLElement | null
}

// 全局按键层叠栈：useEscapeClose 浮层与 modal 弹窗共用同一栈。
// Esc 永远只派发给栈顶层；栈内存在模态层时，落在弹窗外的无修饰键
// 一律拦停——否则焦点留在终端 helper textarea/body 上，Enter/字符会写进
// 背后终端或误触背景按钮
const layers: KeyLayer[] = []
let nextLayerId = 1
let dispatcherInstalled = false

// Enter 的默认激活目标：焦点在这些控件上时 Enter 归控件自己（点击/换行），
// 弹窗层不代为触发 onEnter
const ENTER_SELF_HANDLED =
  'input, textarea, select, button, a[href], summary, [contenteditable=""], [contenteditable="true"], [role="option"], [role="menuitem"], [role="combobox"], [role="listbox"], [role="radio"], [role="checkbox"], [role="switch"], [role="tab"], [role="link"]'
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'

export function hasModalLayerOpen() {
  return layers.some((layer) => !!layer.getEl)
}

export function pushKeyLayer(layer: Omit<KeyLayer, 'id'>) {
  const entry: KeyLayer = { ...layer, id: nextLayerId++ }
  layers.push(entry)
  ensureDispatcher()
  return entry.id
}

export function popKeyLayer(id: number) {
  const index = layers.findIndex((layer) => layer.id === id)
  if (index !== -1) layers.splice(index, 1)
}

function topModalLayer() {
  for (let i = layers.length - 1; i >= 0; i -= 1) if (layers[i].getEl) return layers[i]
  return null
}

function dispatchKeyDown(event: KeyboardEvent) {
  if (!layers.length || isImeKeyEvent(event)) return
  if (event.key === 'Escape') {
    // 栈非空即吞掉 Esc：只有栈顶层响应，背景终端收不到
    event.preventDefault()
    event.stopPropagation()
    layers[layers.length - 1].onEscape?.()
    return
  }
  const modal = topModalLayer()
  const el = modal?.getEl?.()
  if (!modal || !el) return
  const target = event.target as HTMLElement | null
  const plain = !event.ctrlKey && !event.metaKey && !event.altKey
  if (target && el.contains(target)) {
    // 弹窗内非控件区域上的 Enter → 弹窗主操作；控件上的 Enter 归控件
    if (event.key === 'Enter' && plain && !event.shiftKey && !target.closest(ENTER_SELF_HANDLED) && modal.onEnter) {
      event.preventDefault()
      event.stopPropagation()
      modal.onEnter()
    }
    return
  }
  if (!plain) return
  // 焦点在弹窗外的背景上：裸按键拦停，Enter 改道弹窗主操作、Tab 把焦点拉回弹窗
  event.preventDefault()
  event.stopPropagation()
  if (event.key === 'Enter' && !event.shiftKey) modal.onEnter?.()
  else if (event.key === 'Tab') (el.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) || el).focus()
}

function ensureDispatcher() {
  if (dispatcherInstalled) return
  dispatcherInstalled = true
  window.addEventListener('keydown', dispatchKeyDown, true)
}
