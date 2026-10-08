// 尺寸协商状态聚合：owner 主张（lastSize/pending ACK/claimedSize）、共享跟随
// （sharedSize）、独占降级跟随（followedSize）、发送面（sentSize/awaitingAck/
// pendingSend）此前散落在 TerminalPane/runtime/layout/PaneGrid 多个 ref 互相
// 读写，降级/回声/旧 ACK 时序只靠注释约束。这里把状态与转移收敛成单一
// controller；遮罩、snapshot、布局调度、节流定时器等副作用仍留在调用方。
// 协议代次：gateway 下发的 resized/window-size/attached/exclusive-revoked
// 可携带 requestId/windowVersion/ownerEpoch（旧 gateway 字段缺省则全部按
// 尺寸匹配消歧，行为与旧协议一致）。消费方按"同世代内版本不回退、旧世代
// 一律丢弃"过滤乱序/陈旧事件；同事件被 PaneGrid 与 runtime 双订阅消费，
// 因此等值版本视为幂等重复而不是过期。
export interface TermSize {
  cols: number
  rows: number
}
export interface SizeEventMeta {
  requestId?: string | number
  windowVersion?: number
  ownerEpoch?: number
}
export interface TerminalSizeStateOptions {
  // 本端独占主张：服务端仲裁以 attached.exclusive 为准，此 ref 只是本地意图
  attachExclusiveRef: { current: boolean }
  // 无 onResize 消费者时 fit 结果永远等不到确认，不置 pending（保持即时揭开）
  hasResizeConsumer: () => boolean
  lastSize?: TermSize | null
  sharedSize?: TermSize | null
  followedSize?: TermSize | null
}
const sameSize = (a: TermSize | null | undefined, cols: number, rows: number) =>
  !!a && a.cols === cols && a.rows === rows
export function createTerminalSizeState(options: TerminalSizeStateOptions) {
  let lastSize = options.lastSize ?? null
  let sharedSize = options.sharedSize ?? null
  let followedSize = options.followedSize ?? null
  let pendingSize: TermSize | null = null
  // 发送面（PaneGrid 消费）：sentSize=服务端已知尺寸（dedup 基准）；
  // awaitingAck=已发未 ACK（在途限 1）；pendingSend=latest-wins 待发目标；
  // claimedSize=下次 attach 期望主张的本地尺寸（回声不覆盖）
  let sentSize: TermSize | null = null
  let awaitingAck: TermSize | null = null
  let awaitingRequestId: string | number | null = null
  let pendingSend: TermSize | null = null
  let claimedSize: TermSize | null = null
  // 最近确认的服务端时间线快照：windowVersion 同 session 单调递增（跨 owner
  // 世代不回退），ownerEpoch 所有权易主递增。缺省字段不更新，保证旧协议兼容
  let lastWindowVersion = 0
  let lastOwnerEpoch = 0
  // meta 过滤：旧世代（ownerEpoch 更小）或同世代内更旧的版本一律丢弃；
  // 等值版本放行——同一事件被发送面/渲染面两个订阅者顺序消费属幂等
  const observeMeta = (meta?: SizeEventMeta) => {
    const epoch = Number(meta?.ownerEpoch) || 0
    const version = Number(meta?.windowVersion) || 0
    if (epoch > 0 && epoch < lastOwnerEpoch) return false
    if (version > 0 && version < lastWindowVersion) return false
    if (epoch > lastOwnerEpoch) lastOwnerEpoch = epoch
    if (version > lastWindowVersion) lastWindowVersion = version
    return true
  }
  const isExclusiveOwner = () => options.attachExclusiveRef.current
  // 降级跟随期间视共享：渲染修正/fit 主张都不得按独占走
  const isExclusiveRender = () => isExclusiveOwner() && !followedSize
  // 独占 fit 前置条件：被降级（followed 非空）或非独占端都禁止本地主张
  const canExclusiveFit = isExclusiveRender
  // attached：新附着上下文里旧在途 resize 已无意义。followed 必须按服务端
  // detail.exclusive 重写而非本地 ref——降级竞态里本地仍短暂为 true，此时
  // 走独占 fit 会用本机尺寸把刚被抢走的 window 再抢回来（xterm≠tmux）。
  // 附带尺寸时对齐服务端已知尺寸，发送面在途/排队一律作废旧会话上下文
  const noteAttached = (serverExclusive: boolean, cols: number, rows: number, meta?: SizeEventMeta) => {
    observeMeta(meta)
    pendingSize = null
    pendingSend = null
    awaitingAck = null
    if (cols > 0 && rows > 0) sentSize = { cols, rows }
    if (!serverExclusive) {
      if (cols > 0 && rows > 0) followedSize = { cols, rows }
    } else {
      followedSize = null
    }
  }
  // resized（含 localOnly）= 本地在途尺寸的一次确认：匹配即清，不匹配为
  // 过期 ACK（A->B->A 中的旧 B）保持 pending 等末次确认。只消费本地在途
  // ——发送面 ACK 由 ackSentResize 单独判定，两个订阅顺序无关
  const noteResized = (cols: number, rows: number) => {
    if (sameSize(pendingSize, cols, rows)) pendingSize = null
  }
  // 发送面在途 ACK 判定（仅 PaneGrid handleRemoteResized 调用；localOnly
  // 事件须在调用方先过滤——本地确认绝不清真实在途，否则并发闸被假释放）。
  // requestId 双侧都存在时优先按标识配对（旧世代/被覆盖请求的 ACK 即便
  // 尺寸巧合一致也不得释放并发闸）；任一侧缺省退回尺寸匹配兼容旧协议
  const ackSentResize = (cols: number, rows: number, meta?: SizeEventMeta) => {
    if (meta?.ownerEpoch && meta.ownerEpoch < lastOwnerEpoch) return false
    if (!awaitingAck) return false
    if (meta?.requestId != null && awaitingRequestId != null) {
      if (meta.requestId !== awaitingRequestId) return false
    } else if (!sameSize(awaitingAck, cols, rows)) return false
    awaitingAck = null
    awaitingRequestId = null
    return true
  }
  // error/detached 后不会再有 resized ACK：释放等待态让遮罩走兜底揭开
  const noteAbort = () => {
    pendingSize = null
  }
  // window-size 仲裁推送：本端 client pty 已被服务端同步——覆盖共享尺寸并
  // 推翻在途 resize 目标（ACK 不会按旧尺寸回来）；独占端被降级进入跟随，
  // 直到真实容器变化才解除（见 noteContainerChange）。sentSize 对齐推送值，
  // 随后的布局回声 onResize 走 dedup/回声判定不再发包
  // 返回 false 表示陈旧推送被丢弃：调用方的布局同步/定时器清理等
  // 副作用不得执行，否则旧世代事件仍会重排画面
  const noteWindowSize = (cols: number, rows: number, meta?: SizeEventMeta) => {
    if (!observeMeta(meta)) return false
    sharedSize = { cols, rows }
    sentSize = { cols, rows }
    pendingSize = null
    awaitingAck = null
    awaitingRequestId = null
    if (isExclusiveOwner()) followedSize = { cols, rows }
    return true
  }
  // exclusive-revoked 携带的是易主后新 epoch：登记后旧世代的迟来
  // resized/window-size 一并被 observeMeta 判陈旧
  const noteOwnerEpoch = (epoch: number) => {
    if (epoch > lastOwnerEpoch) lastOwnerEpoch = epoch
  }
  // 真实容器变化是新的尺寸主张：独占端解除降级跟随重新 fit。判定用
  // isExclusiveOwner 而非 isExclusiveRender——后者要求 followed 已空，
  // 降级态会永远卡死跟随。非独占端清跟随会抢 window，只返回 true 让
  // 调用方把共享布局对齐到新尺寸
  const noteContainerChange = () => {
    if (isExclusiveOwner()) {
      followedSize = null
      return false
    }
    return followedSize != null
  }
  // 本地布局已把终端落到 next 尺寸（独占 fit 或共享对齐）：sizeChanged 时
  // 登记"已发起待确认"，须先于 onResize 回调置位——回调内的去重/断线分支
  // 会同步发 localOnly resized 清掉它；无消费者则永远等不到确认，不置位
  const noteLocalApplied = (next: TermSize) => {
    const changed = !sameSize(lastSize, next.cols, next.rows)
    lastSize = { cols: next.cols, rows: next.rows }
    if (changed && options.hasResizeConsumer()) pendingSize = { cols: next.cols, rows: next.rows }
    return changed
  }
  // 共享附着携带的服务端权威尺寸（attached.cols/rows，非独占路径）
  const setSharedSize = (cols: number, rows: number) => {
    const changed = !sameSize(sharedSize, cols, rows)
    sharedSize = { cols, rows }
    return changed
  }
  const sizeChangedFromLast = (cols: number, rows: number) => !sameSize(lastSize, cols, rows)
  // 布局回声判定：onResize 产物与跟随中的推送尺寸一致即回声——不发包、不覆盖
  // claimedSize。原 pushedSize 与 followedSize 生命周期等价（推送写、主张清），
  // 合并后由 attach/容器变化统一清理，异尺寸回声由 sentSize dedup 兜底
  const isEchoSize = (cols: number, rows: number) => sameSize(followedSize, cols, rows)
  // 一次 resize 已发往服务端：登记 dedup 基准与在途 ACK（在途限 1）
  const noteResizeSent = (size: TermSize, requestId?: string | number) => {
    sentSize = { cols: size.cols, rows: size.rows }
    awaitingAck = { cols: size.cols, rows: size.rows }
    awaitingRequestId = requestId ?? null
  }
  // ACK 兜底超时：释放在途许可让队列补发
  const noteAckStale = () => {
    awaitingAck = null
    awaitingRequestId = null
  }
  const queueSend = (size: TermSize) => {
    pendingSend = { cols: size.cols, rows: size.rows }
  }
  const clearPendingSend = () => {
    pendingSend = null
  }
  // 卸载/切换/断线/出错统一清理发送面在途与排队（sentSize 保留——远端
  // 侧已生效的尺寸仍是 dedup 基准）；调用方负责自己的定时器
  const resetSendPlane = () => {
    pendingSend = null
    awaitingAck = null
    awaitingRequestId = null
  }
  // attach/detach/error/重连等链路级复位：远端已知尺寸失效
  const resetRemoteSize = () => {
    sentSize = null
  }
  // 会话上下文切换（含主机切换的 sessionId 置空）：上个会话由服务端推送的
  // 共享/降级跟随尺寸与新会话无关——残留会让新终端按旧 geometry 布局；更糟
  // 的是 followedSize 卡住 canExclusiveFit=false，初始 fit 走不到 doFit，
  // notifyReady 永不触发、attach 被 ready 闸永久阻塞（白屏）
  const resetSessionSizes = () => {
    sharedSize = null
    followedSize = null
  }
  // 非回声的本地新尺寸：记为下次 attach 期望主张（回声不得覆盖期望尺寸，
  // 否则 refocus 重新 attach 会拿推送尺寸去主张）
  const noteClaimed = (size: TermSize) => {
    claimedSize = { cols: size.cols, rows: size.rows }
  }
  return {
    get lastSize() {
      return lastSize
    },
    get sharedSize() {
      return sharedSize
    },
    get followedSize() {
      return followedSize
    },
    get pendingSize() {
      return pendingSize
    },
    get sentSize() {
      return sentSize
    },
    get awaitingAck() {
      return awaitingAck
    },
    get pendingSend() {
      return pendingSend
    },
    get claimedSize() {
      return claimedSize
    },
    hasPending: () => pendingSize != null,
    isExclusiveOwner,
    isExclusiveRender,
    canExclusiveFit,
    noteAttached,
    noteResized,
    ackSentResize,
    noteAbort,
    noteWindowSize,
    noteContainerChange,
    noteLocalApplied,
    setSharedSize,
    sizeChangedFromLast,
    get lastWindowVersion() {
      return lastWindowVersion
    },
    get lastOwnerEpoch() {
      return lastOwnerEpoch
    },
    get awaitingRequestId() {
      return awaitingRequestId
    },
    isEchoSize,
    noteResizeSent,
    noteOwnerEpoch,
    noteAckStale,
    queueSend,
    clearPendingSend,
    resetSendPlane,
    resetRemoteSize,
    resetSessionSizes,
    noteClaimed,
  }
}
export type TerminalSizeState = ReturnType<typeof createTerminalSizeState>
