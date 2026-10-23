export const SHUTDOWN_TIMEOUT_MS = 5000

export type ShutdownDeps = {
  logWarn: (message: string) => void
  logError: (error: unknown) => void
  stopMonitor: () => void
  unregisterAgents: (reason: string) => void
  terminateWebSockets: () => void
  shutdownPlugins: () => Promise<void>
  cleanupSockets: () => Promise<void>
  closeServer: () => Promise<void>
  exit: (code: number) => void
  timeoutMs?: number
}

// SIGTERM/SIGINT 关停序列：顺序固定（停监控 → 按真实原因下线 agent → 断 ws → 插件 →
// 复用 socket 清理 → 关 server），并把 process.exit 注入进来以便脱离真实进程做隔离测试。
// 重复信号复用同一个 Promise，避免并发关停把 exit code 打乱。
export function createShutdownSequence(deps: ShutdownDeps) {
  let shutdownPromise: Promise<void> | null = null
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise
    shutdownPromise = (async () => {
      // 活跃 HTTP/WS 连接可能无限阻塞 closeServer()，超时兜底保证有界退出
      const forceExit = setTimeout(() => {
        deps.logWarn('Graceful shutdown timed out; forcing exit')
        deps.exit(1)
      }, deps.timeoutMs ?? SHUTDOWN_TIMEOUT_MS)
      forceExit.unref?.()
      try {
        deps.stopMonitor()
        // 先以真实原因下线 agent，否则 terminate 触发的 ws close 会把原因写成 WebSocket closed
        deps.unregisterAgents('Gateway restarted')
        // ws 长连接不随 HTTP server 关闭自动断开，显式终止以免阻塞排空
        deps.terminateWebSockets()
        await deps.shutdownPlugins()
        await deps.cleanupSockets()
        await deps.closeServer()
        deps.exit(0)
      } catch (err) {
        deps.logError(err)
        deps.exit(1)
      } finally {
        clearTimeout(forceExit)
      }
    })()
    return shutdownPromise
  }
  return shutdown
}
