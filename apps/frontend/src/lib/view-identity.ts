// 浏览器视角 id：每个浏览器一个稳定值，attach 与切窗口都带上。
// 网关拿它做 tmux grouped session，给这个浏览器独立的 current window，
// 同时仍共享 pane 内容；没有该字段时行为不变（老网关直接忽略）。
const STORAGE_KEY = 'tmuxgo.viewId.v1'
// 契约：8-64 位 [A-Za-z0-9_-]；本文件只生成 32 位小写 hex，校验放宽到契约全集，
// 这样手工写入的合法 id 也能沿用，不会被无谓改写。
const VIEW_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

let cachedViewId: string | null = null

export function isValidViewId(value: unknown): value is string {
  return typeof value === 'string' && VIEW_ID_PATTERN.test(value)
}

function getStorage(): Storage | null {
  try {
    // SSR/Node 下可能没有 localStorage；Node 22 的 localStorage getter 还可能抛，
    // 所以连属性读取一起兜住。
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage
  } catch {
    return null
  }
}

function readStoredViewId(): string | null {
  try {
    return getStorage()?.getItem(STORAGE_KEY) ?? null
  } catch {
    return null
  }
}

function writeStoredViewId(viewId: string) {
  try {
    getStorage()?.setItem(STORAGE_KEY, viewId)
  } catch {
    // 隐私模式/配额满：写入失败不影响本次使用，模块缓存保证同一页面内稳定
  }
}

function fromRandomUUID(): string | null {
  const cryptoObj = globalThis.crypto
  if (!cryptoObj || typeof cryptoObj.randomUUID !== 'function') return null
  try {
    const hex = cryptoObj.randomUUID().replace(/-/g, '')
    return isValidViewId(hex) ? hex : null
  } catch {
    return null
  }
}

function fromRandomValues(): string | null {
  const cryptoObj = globalThis.crypto
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') return null
  try {
    const bytes = new Uint8Array(16)
    cryptoObj.getRandomValues(bytes)
    let hex = ''
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
    return isValidViewId(hex) ? hex : null
  } catch {
    return null
  }
}

function fromMathRandom(): string {
  // 仅测试环境/极老运行时的兜底：viewId 只用来区分浏览器视角，不是安全凭据。
  let hex = ''
  while (hex.length < 32) hex += Math.floor(Math.random() * 16).toString(16)
  return hex.slice(0, 32)
}

function generateViewId(): string {
  return fromRandomUUID() || fromRandomValues() || fromMathRandom()
}

export function getViewId(): string {
  if (cachedViewId) return cachedViewId
  const stored = readStoredViewId()
  if (isValidViewId(stored)) {
    cachedViewId = stored
    return cachedViewId
  }
  // 缺失或非法值：重新生成并尽量写回，让同一浏览器下次还认这个视角
  const next = generateViewId()
  cachedViewId = next
  writeStoredViewId(next)
  return next
}

// 只给测试用：清模块缓存，避免用例之间互相污染
export function __resetViewIdForTest() {
  cachedViewId = null
}
