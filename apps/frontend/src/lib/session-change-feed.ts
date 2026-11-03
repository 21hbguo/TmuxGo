'use client'
// 会话列表变更订阅（客户端半侧）：每个 host 一条长轮询，变更到达就把
// `['sessions', hostId]` 的观察者叫起来重取。目标是「别人在 tmux CLI 里
// 新建/删掉一个 session，会话区 1-3s 内自己变」，而不是等 10s 兜底轮询。
//
// 为什么一个 host 只挂一条：SessionPanel/SessionRail/ConsoleLayout 都会观察
// 同一份列表，各挂一条等于同一份变更被问 N 遍。这里按 hostId 做引用计数去重。
//
// 失败策略：404/405/501 视为「网关没有这个端点」（老网关/中间层不支持），
// 永久停用本 host 的订阅，退回 useSessions 的兜底轮询，不刷错误也不重试；
// 其余错误（断网/网关重启）指数退避到 30s，恢复后自动续上。

import { api } from '@/lib/api'

export const SESSION_CHANGE_WAIT_MS = 20000
const RETRY_MIN_MS = 1000
const RETRY_MAX_MS = 30000

type ChangeListener = () => void

interface HostFeed {
  listeners: Set<ChangeListener>
  revision: number | null
  failures: number
  running: boolean
  disabled: boolean
  controller: AbortController | null
  retryTimer: ReturnType<typeof setTimeout> | null
  retryResolve: (() => void) | null
  visibilityHandler: (() => void) | null
}

const feeds = new Map<string, HostFeed>()

function isHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

function notify(feed: HostFeed) {
  for (const listener of [...feed.listeners]) {
    try {
      listener()
    } catch {
      // 单个观察者抛错不能拖垮其它观察者（hook 卸载时的竞态）
    }
  }
}

function teardown(hostId: string, feed: HostFeed) {
  feed.disabled = true
  feed.controller?.abort()
  feed.controller = null
  if (feed.retryTimer) clearTimeout(feed.retryTimer)
  feed.retryTimer = null
  // 退避等待也要能立刻结束，否则取消订阅后 pump 的 promise 会挂到超时
  feed.retryResolve?.()
  feed.retryResolve = null
  if (feed.visibilityHandler && typeof document !== 'undefined')
    document.removeEventListener('visibilitychange', feed.visibilityHandler)
  feed.visibilityHandler = null
  if (feeds.get(hostId) === feed) feeds.delete(hostId)
}

function waitRetry(feed: HostFeed, delayMs: number) {
  return new Promise<void>((resolve) => {
    feed.retryResolve = resolve
    feed.retryTimer = setTimeout(() => {
      feed.retryTimer = null
      feed.retryResolve = null
      resolve()
    }, delayMs)
  })
}

async function pump(hostId: string, feed: HostFeed) {
  if (feed.running || feed.disabled || feeds.get(hostId) !== feed) return
  feed.running = true
  try {
    while (!feed.disabled && feed.listeners.size > 0) {
      // 后台标签页不挂长请求：移动端被系统挂起时连接会半死，回前台再续
      if (isHidden()) return
      const changes = api.sessions?.changes
      if (typeof changes !== 'function') {
        feed.disabled = true
        return
      }
      const controller = new AbortController()
      feed.controller = controller
      try {
        const result = await changes(hostId, feed.revision, SESSION_CHANGE_WAIT_MS, controller.signal)
        if (feed.disabled) return
        feed.failures = 0
        const previous = feed.revision
        feed.revision = result.revision
        // 首帧只对齐版本号：此刻缓存刚由 REST 取回，再 invalidate 一次是白跑
        if (previous !== null && result.revision !== previous) notify(feed)
      } catch (error) {
        if (feed.disabled) return
        const name = error instanceof Error ? error.name : ''
        if (name === 'AbortError') return
        const status = (error as { status?: number } | null)?.status
        if (status === 404 || status === 405 || status === 501 || status === 403) {
          feed.disabled = true
          return
        }
        feed.failures += 1
        const delay = Math.min(RETRY_MIN_MS * 2 ** (feed.failures - 1), RETRY_MAX_MS)
        await waitRetry(feed, delay)
      } finally {
        if (feed.controller === controller) feed.controller = null
      }
    }
  } finally {
    feed.running = false
  }
}

/**
 * 订阅某个 host 的会话列表变更。返回值是取消订阅函数；
 * 最后一个订阅者离开时整条长轮询（含可见性监听）一起拆掉。
 */
export function subscribeSessionChanges(hostId: string, listener: ChangeListener): () => void {
  if (!hostId) return () => {}
  let feed = feeds.get(hostId)
  if (!feed) {
    feed = {
      listeners: new Set(),
      revision: null,
      failures: 0,
      running: false,
      disabled: false,
      controller: null,
      retryTimer: null,
      retryResolve: null,
      visibilityHandler: null,
    }
    feeds.set(hostId, feed)
  }
  const target = feed
  target.listeners.add(listener)
  if (!target.visibilityHandler && typeof document !== 'undefined') {
    target.visibilityHandler = () => {
      if (target.disabled) return
      if (isHidden()) {
        target.controller?.abort()
        return
      }
      void pump(hostId, target)
    }
    document.addEventListener('visibilitychange', target.visibilityHandler)
  }
  void pump(hostId, target)
  return () => {
    if (feeds.get(hostId) !== target) return
    target.listeners.delete(listener)
    if (target.listeners.size > 0) return
    teardown(hostId, target)
  }
}

/** 测试用：清空全部订阅与在途请求 */
export function resetSessionChangeFeedsForTests() {
  for (const [hostId, feed] of [...feeds]) teardown(hostId, feed)
}
