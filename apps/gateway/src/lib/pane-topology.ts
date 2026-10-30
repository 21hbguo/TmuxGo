// pane 拓扑编辑（move / break / swap）的纯逻辑层。
// 这里只做「pane/window 引用解析 + 参数校验 + tmux argv 构造」，不执行任何 tmux 命令：
// 路由拿到 argv 后自己走 execTmux，单测可以直接断言 argv 形状和非法输入而不触 tmux。
// 之所以把校验也放进来：跨 host、同 pane、双 target 这些约束必须与 argv 构造共用一份
// 判据，避免「路由放过、argv 却指向另一个 host」这类不一致。

export type PaneDirection = 'horizontal' | 'vertical'

export interface PaneRef {
  hostId: string
  tmuxPaneId: string
}
export interface WindowRef {
  hostId: string
  tmuxWindowId: string
}

// 结构化的参数/目标错误：httpStatus 让拓扑路由不必再按文案猜 HTTP 状态。
// 400 = 调用方参数问题（跨 host、同 pane、双 target、sizePercent 越界…）；
// 403 = 策略拒绝（allowlist 之外的 session / 请求 scope 不允许）。
// 字段特意不叫 statusCode：Fastify 默认错误处理器会读 error.statusCode 并据此回包，
// 而这个类也会从既有路由（parsePaneRef 的旧用法）里抛出——改名保住它们原来的 500 语义。
export class PaneTopologyError extends Error {
  readonly code: string
  readonly httpStatus: number
  constructor(code: string, message: string, httpStatus = 400) {
    super(message)
    this.name = 'PaneTopologyError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

// 与 routes/panes.ts 原 parsePaneId 行为完全一致（同样只认 <host>:%<n>，
// 错误文案不变），只是把「非法 pane 引用」升级成带 code 的结构化错误。
export function parsePaneRef(paneId: string): PaneRef {
  const separator = paneId.indexOf(':')
  if (separator <= 0 || separator === paneId.length - 1)
    throw new PaneTopologyError('INVALID_PANE_ID', 'Invalid pane id')
  const hostId = paneId.slice(0, separator)
  const tmuxPaneId = paneId.slice(separator + 1)
  if (!tmuxPaneId.startsWith('%')) throw new PaneTopologyError('INVALID_PANE_ID', 'Invalid pane id')
  return { hostId, tmuxPaneId }
}

// 窗口引用形如 local:@3；pane 用 % 前缀、window 用 @ 前缀，两者不可混用
export function parseWindowRef(windowId: string): WindowRef {
  const separator = windowId.indexOf(':')
  if (separator <= 0 || separator === windowId.length - 1)
    throw new PaneTopologyError('INVALID_WINDOW_ID', 'Invalid window id')
  const hostId = windowId.slice(0, separator)
  const tmuxWindowId = windowId.slice(separator + 1)
  if (!tmuxWindowId.startsWith('@')) throw new PaneTopologyError('INVALID_WINDOW_ID', 'Invalid window id')
  return { hostId, tmuxWindowId }
}

// tmux 的 window name 会进 status line / list-windows，控制字符（含换行）能污染
// 整个格式串，所以这里和 zod schema 双重收口：1-64 字符、无 C0 控制字符与 DEL
function isValidPaneBreakName(name: string) {
  // eslint-disable-next-line no-control-regex -- 这里正是要拒绝控制字符（含 DEL）
  return name.length >= 1 && name.length <= 64 && !/[\u0000-\u001f\u007f]/.test(name)
}

function assertDifferentPane(source: PaneRef, target: PaneRef) {
  if (target.tmuxPaneId === source.tmuxPaneId)
    throw new PaneTopologyError('SAME_PANE', 'Source and target pane must differ')
}

export interface JoinPaneOptions {
  paneId: string
  targetWindowId?: string
  targetPaneId?: string
  direction?: PaneDirection
  sizePercent?: number
}

// join-pane -d -h|-v [-l n%] -s <src-pane> -t <dst-pane|dst-window>
// -d：搬过去但不切换 active pane（前端拖拽后自己决定选中谁，别让 tmux 抢焦点）
export function buildJoinPaneArgs(input: JoinPaneOptions): string[] {
  const source = parsePaneRef(input.paneId)
  const targetWindowId = input.targetWindowId?.trim() || undefined
  const targetPaneId = input.targetPaneId?.trim() || undefined
  if (!targetWindowId && !targetPaneId)
    throw new PaneTopologyError('MISSING_TARGET', 'targetWindowId or targetPaneId is required')
  if (targetWindowId && targetPaneId)
    throw new PaneTopologyError('MULTIPLE_TARGETS', 'targetWindowId and targetPaneId are mutually exclusive')
  const direction = input.direction ?? 'horizontal'
  if (direction !== 'horizontal' && direction !== 'vertical')
    throw new PaneTopologyError('INVALID_DIRECTION', 'direction must be horizontal or vertical')
  const { sizePercent } = input
  // 只接受整数百分比：tmux 的 -l 同时支持「行/列数」和「n%」，小数或 0 会被解释成
  // 切除该 pane 或直接报错；10-90 之外搬过去也没有可用空间
  if (sizePercent !== undefined && (!Number.isInteger(sizePercent) || sizePercent < 10 || sizePercent > 90))
    throw new PaneTopologyError('INVALID_SIZE', 'sizePercent must be an integer between 10 and 90')

  let target: string
  if (targetPaneId) {
    const targetRef = parsePaneRef(targetPaneId)
    if (targetRef.hostId !== source.hostId) throw new PaneTopologyError('CROSS_HOST', 'Pane does not belong to host')
    assertDifferentPane(source, targetRef)
    target = targetRef.tmuxPaneId
  } else {
    const targetRef = parseWindowRef(targetWindowId!)
    if (targetRef.hostId !== source.hostId) throw new PaneTopologyError('CROSS_HOST', 'Window does not belong to host')
    target = targetRef.tmuxWindowId
  }

  return [
    'join-pane',
    '-d',
    direction === 'horizontal' ? '-h' : '-v',
    ...(sizePercent !== undefined ? ['-l', `${sizePercent}%`] : []),
    '-s',
    source.tmuxPaneId,
    '-t',
    target,
  ]
}

export interface BreakPaneOptions {
  paneId: string
  name?: string
}

// break-pane -d -s <pane> [-n <name>]：把 pane 独立成新窗口，新窗口沿用该 pane 的进程
export function buildBreakPaneArgs(input: BreakPaneOptions): string[] {
  const source = parsePaneRef(input.paneId)
  const name = input.name
  if (name !== undefined && !isValidPaneBreakName(name))
    throw new PaneTopologyError('INVALID_NAME', 'name must be 1-64 characters without control characters')
  return ['break-pane', '-d', '-s', source.tmuxPaneId, ...(name !== undefined ? ['-n', name] : [])]
}

export interface SwapPaneOptions {
  paneId: string
  targetPaneId: string
}

// swap-pane -s <a> -t <b>：两个 pane 的位置互换（进程跟着 pane 走，不是换内容）
export function buildSwapPaneArgs(input: SwapPaneOptions): string[] {
  const source = parsePaneRef(input.paneId)
  const targetPaneId = input.targetPaneId?.trim()
  if (!targetPaneId) throw new PaneTopologyError('MISSING_TARGET', 'targetPaneId is required')
  const target = parsePaneRef(targetPaneId)
  if (target.hostId !== source.hostId) throw new PaneTopologyError('CROSS_HOST', 'Pane does not belong to host')
  assertDifferentPane(source, target)
  return ['swap-pane', '-s', source.tmuxPaneId, '-t', target.tmuxPaneId]
}

// 失败归类：结构化错误自带状态码；tmux-policy 的 allowlist 拒绝 → 403；
// 目标不存在/解析不到（tmux 的 can't find / unable to resolve）→ 404；
// 其余（ssh/agent 通道、tmux 自身异常）→ 502。路由据此回 { ok:false, error }。
export function classifyPaneTopologyError(error: unknown): { statusCode: number; message: string } {
  const message = error instanceof Error && error.message ? error.message : 'Request failed'
  if (error instanceof PaneTopologyError) return { statusCode: error.httpStatus, message }
  if (/not allowed/i.test(message)) return { statusCode: 403, message }
  if (/^(Invalid pane id|Invalid window id|Invalid session name|Missing tmux target)/.test(message))
    return { statusCode: 400, message }
  if (
    /can't find (session|window|pane)|no such (session|window|pane)|Unable to resolve session|no current (target|session|window|pane)|no server running/i.test(
      message,
    )
  )
    return { statusCode: 404, message }
  return { statusCode: 502, message }
}
