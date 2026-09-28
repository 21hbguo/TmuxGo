import { describe, expect, it } from 'vitest'
import { createTerminalSizeState, type TermSize } from './terminal-size-state'

interface Init {
  exclusive?: boolean
  consumer?: boolean
  lastSize?: TermSize | null
  sharedSize?: TermSize | null
  followedSize?: TermSize | null
}
// hasResizeConsumer 对应 layout onResizeRef 判空语义：无消费者不登记 pending
const state = ({ exclusive = true, consumer = true, ...init }: Init = {}) =>
  createTerminalSizeState({
    attachExclusiveRef: { current: exclusive },
    hasResizeConsumer: () => consumer,
    ...init,
  })

describe('terminal-size-state', () => {
  it('owner attach clears any stale follow and pending ACK', () => {
    const s = state({ followedSize: { cols: 137, rows: 23 } })
    s.noteLocalApplied({ cols: 90, rows: 30 })
    expect(s.pendingSize).toEqual({ cols: 90, rows: 30 })
    s.noteAttached(true, 90, 30)
    expect(s.followedSize).toBe(null)
    expect(s.pendingSize).toBe(null)
    expect(s.canExclusiveFit()).toBe(true)
  })
  it('demoted attach follows the window size and keeps it without valid cols', () => {
    const s = state()
    s.noteAttached(false, 137, 23)
    expect(s.followedSize).toEqual({ cols: 137, rows: 23 })
    expect(s.canExclusiveFit()).toBe(false)
    // 不带尺寸的降级 attach 不得意外清跟随（attached 非独占且无 cols 时保持现状）
    s.noteAttached(false, 0, 0)
    expect(s.followedSize).toEqual({ cols: 137, rows: 23 })
  })
  it('window-size push demotes the owner, overrides shared size and kills pending', () => {
    const s = state()
    s.noteLocalApplied({ cols: 90, rows: 30 })
    expect(s.pendingSize).toEqual({ cols: 90, rows: 30 })
    s.noteWindowSize(120, 36)
    expect(s.sharedSize).toEqual({ cols: 120, rows: 36 })
    expect(s.pendingSize).toBe(null)
    expect(s.followedSize).toEqual({ cols: 120, rows: 36 })
    expect(s.isExclusiveRender()).toBe(false)
  })
  it('window-size push on a shared client updates shared without follow', () => {
    const s = state({ exclusive: false })
    s.noteWindowSize(120, 36)
    expect(s.sharedSize).toEqual({ cols: 120, rows: 36 })
    expect(s.followedSize).toBe(null)
  })
  it('a real container change lets the demoted owner exit follow; shared client only re-syncs', () => {
    const owner = state({ followedSize: { cols: 137, rows: 23 } })
    expect(owner.noteContainerChange()).toBe(false)
    expect(owner.followedSize).toBe(null)
    const shared = state({ exclusive: false, followedSize: { cols: 137, rows: 23 } })
    expect(shared.noteContainerChange()).toBe(true)
    expect(shared.followedSize).toEqual({ cols: 137, rows: 23 })
  })
  it('resized ACK clears only a matching in-flight size; a stale ACK keeps it pending', () => {
    const s = state()
    s.noteLocalApplied({ cols: 90, rows: 30 })
    // 过期 ACK（A->B->A 中的旧 B）：不匹配末次在途，必须保持 pending
    s.noteResized(80, 24)
    expect(s.pendingSize).toEqual({ cols: 90, rows: 30 })
    s.noteResized(90, 30)
    expect(s.pendingSize).toBe(null)
  })
  it('abort releases pending so the mask can fall back to a failsafe reveal', () => {
    const s = state()
    s.noteLocalApplied({ cols: 90, rows: 30 })
    s.noteAbort()
    expect(s.pendingSize).toBe(null)
  })
  it('records pending only when a resize consumer exists', () => {
    const orphan = state({ consumer: false })
    expect(orphan.noteLocalApplied({ cols: 90, rows: 30 })).toBe(true)
    expect(orphan.pendingSize).toBe(null)
    const owned = state()
    expect(owned.noteLocalApplied({ cols: 90, rows: 30 })).toBe(true)
    expect(owned.pendingSize).toEqual({ cols: 90, rows: 30 })
    // 同尺寸重复落地不重复登记
    owned.noteAbort()
    expect(owned.noteLocalApplied({ cols: 90, rows: 30 })).toBe(false)
    expect(owned.pendingSize).toBe(null)
  })
  it('reports shared size changes once and remembers last applied size', () => {
    const s = state({ exclusive: false, lastSize: { cols: 80, rows: 24 } })
    expect(s.setSharedSize(120, 36)).toBe(true)
    expect(s.setSharedSize(120, 36)).toBe(false)
    expect(s.sizeChangedFromLast(80, 24)).toBe(false)
    expect(s.sizeChangedFromLast(81, 24)).toBe(true)
  })
  it('send plane: sent/awaiting tracked together and released only by matching ACK', () => {
    const s = state()
    s.noteResizeSent({ cols: 121, rows: 40 })
    expect(s.sentSize).toEqual({ cols: 121, rows: 40 })
    expect(s.awaitingAck).toEqual({ cols: 121, rows: 40 })
    // 异尺寸旧 ACK 不释放在途；无在途的重复 ACK 也不凭空推进
    expect(s.ackSentResize(99, 30)).toBe(false)
    expect(s.awaitingAck).not.toBe(null)
    expect(s.ackSentResize(121, 40)).toBe(true)
    expect(s.awaitingAck).toBe(null)
    expect(s.ackSentResize(121, 40)).toBe(false)
  })
  it('send plane: stale timeout releases in-flight so the queue can flush', () => {
    const s = state()
    s.noteResizeSent({ cols: 121, rows: 40 })
    s.queueSend({ cols: 130, rows: 40 })
    s.noteAckStale()
    expect(s.awaitingAck).toBe(null)
    expect(s.pendingSend).toEqual({ cols: 130, rows: 40 })
  })
  it('send plane: window-size push aligns sent size, kills in-flight and marks echo', () => {
    const s = state()
    s.noteResizeSent({ cols: 121, rows: 40 })
    s.noteWindowSize(137, 23)
    expect(s.sentSize).toEqual({ cols: 137, rows: 23 })
    expect(s.awaitingAck).toBe(null)
    expect(s.isEchoSize(137, 23)).toBe(true)
    expect(s.isEchoSize(120, 36)).toBe(false)
  })
  it('send plane: attach resets queued/in-flight and seeds remote-known size', () => {
    const s = state()
    s.noteResizeSent({ cols: 121, rows: 40 })
    s.queueSend({ cols: 130, rows: 40 })
    s.noteAttached(true, 120, 36)
    expect(s.pendingSend).toBe(null)
    expect(s.awaitingAck).toBe(null)
    expect(s.sentSize).toEqual({ cols: 120, rows: 36 })
  })
  it('send plane: resetSendPlane keeps sentSize, resetRemoteSize drops it', () => {
    const s = state()
    s.noteResizeSent({ cols: 121, rows: 40 })
    s.queueSend({ cols: 130, rows: 40 })
    s.resetSendPlane()
    expect(s.awaitingAck).toBe(null)
    expect(s.pendingSend).toBe(null)
    expect(s.sentSize).toEqual({ cols: 121, rows: 40 })
    s.resetRemoteSize()
    expect(s.sentSize).toBe(null)
  })
  it('claimed size keeps the last real local size across an echo', () => {
    const s = state()
    s.noteClaimed({ cols: 121, rows: 40 })
    s.noteWindowSize(137, 23)
    // 回声只匹配跟随尺寸，不覆盖期望主张
    expect(s.isEchoSize(137, 23)).toBe(true)
    expect(s.claimedSize).toEqual({ cols: 121, rows: 40 })
  })
})

describe('terminal-size-state protocol meta', () => {
  it('rejects a window-size push older than the latest observed version', () => {
    const s = state()
    expect(s.noteWindowSize(120, 36, { windowVersion: 5, ownerEpoch: 1 })).toBe(true)
    expect(s.sharedSize).toEqual({ cols: 120, rows: 36 })
    // 乱序到达的旧版本推送：整体丢弃，不覆盖共享尺寸/跟随态
    expect(s.noteWindowSize(90, 30, { windowVersion: 3, ownerEpoch: 1 })).toBe(false)
    expect(s.sharedSize).toEqual({ cols: 120, rows: 36 })
    // 同版本重复投递（发送面/渲染面双订阅）属幂等放行
    expect(s.noteWindowSize(120, 36, { windowVersion: 5, ownerEpoch: 1 })).toBe(true)
    expect(s.noteWindowSize(130, 40, { windowVersion: 6, ownerEpoch: 1 })).toBe(true)
  })
  it('drops events from an older owner epoch after exclusive-revoked advanced the epoch', () => {
    const s = state()
    expect(s.noteWindowSize(120, 36, { windowVersion: 4, ownerEpoch: 2 })).toBe(true)
    s.noteOwnerEpoch(3)
    // 旧世代迟来推送——即使版本号更大也必须丢弃
    expect(s.noteWindowSize(90, 30, { windowVersion: 9, ownerEpoch: 2 })).toBe(false)
    expect(s.sharedSize).toEqual({ cols: 120, rows: 36 })
    // 新世代事件正常放行
    expect(s.noteWindowSize(90, 30, { windowVersion: 9, ownerEpoch: 3 })).toBe(true)
    expect(s.sharedSize).toEqual({ cols: 90, rows: 30 })
  })
  it('matches resized ACK by requestId and rejects a mismatched id even at the same size', () => {
    const s = state()
    s.noteResizeSent({ cols: 100, rows: 30 }, 7)
    // 旧世代迟来 ACK：ownerEpoch 落后于 exclusive-revoked 登记的世代
    s.noteOwnerEpoch(4)
    expect(s.ackSentResize(100, 30, { requestId: 7, ownerEpoch: 3 })).toBe(false)
    expect(s.awaitingAck).toEqual({ cols: 100, rows: 30 })
    // requestId 不符：同尺寸也不放行
    expect(s.ackSentResize(100, 30, { requestId: 8, ownerEpoch: 4 })).toBe(false)
    expect(s.awaitingAck).toEqual({ cols: 100, rows: 30 })
    expect(s.ackSentResize(100, 30, { requestId: 7, ownerEpoch: 4 })).toBe(true)
    expect(s.awaitingAck).toBe(null)
  })
  it('falls back to size matching when the ACK carries no requestId (legacy gateway)', () => {
    const s = state()
    s.noteResizeSent({ cols: 100, rows: 30 }, 9)
    expect(s.ackSentResize(90, 24)).toBe(false)
    expect(s.ackSentResize(100, 30)).toBe(true)
  })
  it('records attach-time meta without blocking subsequent events', () => {
    const s = state()
    s.noteAttached(true, 80, 24, { windowVersion: 10, ownerEpoch: 2 })
    expect(s.lastWindowVersion).toBe(10)
    expect(s.lastOwnerEpoch).toBe(2)
    expect(s.noteWindowSize(88, 28, { windowVersion: 11, ownerEpoch: 2 })).toBe(true)
  })
})
