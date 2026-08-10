import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWebSocket } from './useWebSocket'
const updateConnectionMock=vi.fn()
const preferenceState={autoReconnect:false,reconnectInterval:1000}
const authState={enabled:false}
const getWebSocketUrlMock=vi.fn()
const socketInstances:MockWebSocket[]=[]
class MockWebSocket {
  static OPEN=1
  static CONNECTING=0
  static CLOSING=2
  static CLOSED=3
  readyState=MockWebSocket.CONNECTING
  onopen:((event?:Event)=>void)|null=null
  onmessage:((event:{data:string})=>void)|null=null
  onerror:(()=>void)|null=null
  onclose:(()=>void)|null=null
  bufferedAmount=0
  constructor(_url:string) {
    socketInstances.push(this)
  }
  send(_data:string) {}
  close() {
    this.readyState=MockWebSocket.CLOSED
    this.onclose?.()
  }
  error() {
    this.onerror?.()
  }
  open() {
    this.readyState=MockWebSocket.OPEN
    this.onopen?.()
  }
  message(data:unknown) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
}
vi.mock('./usePreferences',()=>({
  usePreferences:()=>({ preferences: preferenceState }),
}))
vi.mock('@/stores/useConsoleStore',()=>({
  useConsoleStore:((selector:any)=>selector({ connection:{ status:'disconnected' }, updateConnection:updateConnectionMock })) as any,
}))
vi.mock('@/lib/runtime-endpoints',()=>({
  getWebSocketBase:()=> 'ws://localhost:3000/api/stream',
}))
vi.mock('@/lib/auth',()=>({
  isAuthEnabled:()=>authState.enabled,
  getWebSocketUrl:()=>getWebSocketUrlMock(),
}))
vi.mock('@/lib/mobile-diagnostics',()=>({
  recordMobileDiagnostic:vi.fn(),
}))
describe('useWebSocket',()=>{
  beforeEach(()=>{
    vi.useFakeTimers()
    updateConnectionMock.mockReset()
    preferenceState.autoReconnect=false
    preferenceState.reconnectInterval=1000
    authState.enabled=false
    getWebSocketUrlMock.mockReset()
    socketInstances.length=0
    Object.defineProperty(document,'visibilityState',{ configurable:true, value:'visible' })
    vi.stubGlobal('WebSocket', MockWebSocket as any)
  })
  afterEach(()=>{
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  it('dispatches terminal attach errors and leaves attaching state',async()=>{
    const tmuxErrorListener=vi.fn()
    window.addEventListener('tmux-error',tmuxErrorListener as EventListener)
    const { unmount }=renderHook(() => useWebSocket())
    expect(socketInstances.length).toBe(1)
    act(()=>{
      socketInstances[0].open()
    })
    expect(updateConnectionMock).toHaveBeenCalledWith({status:'attaching',latency:0})
    act(()=>{
      socketInstances[0].message({ type:'error', message:'Session not found', hostId:'local', sessionName:'dev' })
    })
    expect(tmuxErrorListener).toHaveBeenCalledTimes(1)
    expect(updateConnectionMock).toHaveBeenCalledWith({status:'disconnected'})
    expect((tmuxErrorListener.mock.calls[0]?.[0] as CustomEvent).detail).toMatchObject({ message:'Session not found', hostId:'local', sessionName:'dev' })
    window.removeEventListener('tmux-error',tmuxErrorListener as EventListener)
    unmount()
  })
  it('routes terminal output to its host and session listeners only',()=>{
    const listener=vi.fn()
    const otherSessionListener=vi.fn()
    const otherHostListener=vi.fn()
    const { result, unmount }=renderHook(() => useWebSocket())
    act(()=>{
      socketInstances[0].open()
    })
    const unsubscribe=result.current.subscribeOutput('local','dev',listener)
    const unsubscribeOtherSession=result.current.subscribeOutput('local','other',otherSessionListener)
    const unsubscribeOtherHost=result.current.subscribeOutput('remote','dev',otherHostListener)
    act(()=>{
      socketInstances[0].message({ type:'output_resync', data:'snapshot', hostId:'local', sessionName:'dev' })
    })
    expect(listener).toHaveBeenCalledWith({ data:'snapshot', hostId:'local', sessionName:'dev', resync:true })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(otherSessionListener).not.toHaveBeenCalled()
    expect(otherHostListener).not.toHaveBeenCalled()
    unsubscribe()
    unsubscribeOtherSession()
    unsubscribeOtherHost()
    unmount()
  })
  it('dispatches completed terminal resize events',()=>{
    const listener=vi.fn()
    window.addEventListener('tmux-resized',listener as EventListener)
    const { unmount }=renderHook(() => useWebSocket())
    act(()=>{
      socketInstances[0].open()
      socketInstances[0].message({ type:'resized', hostId:'local', sessionName:'dev', cols:120, rows:36 })
    })
    expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toMatchObject({ hostId:'local', sessionName:'dev', cols:120, rows:36 })
    window.removeEventListener('tmux-resized',listener as EventListener)
    unmount()
  })
  it('dispatches agent status events',()=>{
    const listener=vi.fn()
    window.addEventListener('tmuxgo-agent-status',listener as EventListener)
    const { unmount }=renderHook(() => useWebSocket())
    act(()=>{
      socketInstances[0].open()
      socketInstances[0].message({ type:'agent_status_changed', hostId:'local', sessionName:'dev', pane:{ paneId:'local:%1', agent:'codex', agentStatus:'blocked', revision:2 } })
    })
    expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toMatchObject({ hostId:'local', sessionName:'dev', pane:{ agentStatus:'blocked' } })
    window.removeEventListener('tmuxgo-agent-status',listener as EventListener)
    unmount()
  })
  it('dispatches the agent monitor event types',()=>{
    const listeners = { snapshot: vi.fn(), removed: vi.fn(), notification: vi.fn(), error: vi.fn() }
    window.addEventListener('tmuxgo-agent-status-snapshot', listeners.snapshot as EventListener)
    window.addEventListener('tmuxgo-agent-status-removed', listeners.removed as EventListener)
    window.addEventListener('tmuxgo-agent-notification', listeners.notification as EventListener)
    window.addEventListener('tmuxgo-agent-monitor-error', listeners.error as EventListener)
    const { unmount } = renderHook(() => useWebSocket())
    const snapshot = { type: 'agent_status_snapshot', initial: true, hostId: 'local', revision: 3, agents: [] }
    const removed = { type: 'agent_status_removed', initial: false, hostId: 'local', sessionName: 'dev', paneId: 'local:%1', reason: 'pane_exited' }
    const notification = { type: 'agent_notification', initial: false, hostId: 'local', sessionName: 'dev', eventId: 'local:local:%1:failed:4', pane: { paneId: 'local:%1', agent: 'codex', agentStatus: 'unknown', phase: 'failed', revision: 4 } }
    const monitorError = { type: 'agent_monitor_error', initial: false, hostId: 'remote', message: 'Agent monitor scan failed', retrying: true }
    act(() => {
      socketInstances[0].open()
      socketInstances[0].message(snapshot)
      socketInstances[0].message(removed)
      socketInstances[0].message(notification)
      socketInstances[0].message(monitorError)
    })
    expect((listeners.snapshot.mock.calls[0]?.[0] as CustomEvent).detail).toEqual(snapshot)
    expect((listeners.removed.mock.calls[0]?.[0] as CustomEvent).detail).toEqual(removed)
    expect((listeners.notification.mock.calls[0]?.[0] as CustomEvent).detail).toEqual(notification)
    expect((listeners.error.mock.calls[0]?.[0] as CustomEvent).detail).toEqual(monitorError)
    window.removeEventListener('tmuxgo-agent-status-snapshot', listeners.snapshot as EventListener)
    window.removeEventListener('tmuxgo-agent-status-removed', listeners.removed as EventListener)
    window.removeEventListener('tmuxgo-agent-notification', listeners.notification as EventListener)
    window.removeEventListener('tmuxgo-agent-monitor-error', listeners.error as EventListener)
    unmount()
  })
  it('replaces a stale socket after returning from the background',()=>{
    const { unmount }=renderHook(() => useWebSocket())
    act(()=>{
      socketInstances[0].open()
      Object.defineProperty(document,'visibilityState',{ configurable:true, value:'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
      vi.advanceTimersByTime(1201)
      Object.defineProperty(document,'visibilityState',{ configurable:true, value:'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(socketInstances[0].readyState).toBe(MockWebSocket.CLOSED)
    expect(socketInstances).toHaveLength(2)
    unmount()
  })
  it('replaces a socket that is still connecting after returning from the background',()=>{
    const { unmount }=renderHook(() => useWebSocket())
    act(()=>{
      Object.defineProperty(document,'visibilityState',{ configurable:true, value:'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
      vi.advanceTimersByTime(1201)
      Object.defineProperty(document,'visibilityState',{ configurable:true, value:'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(socketInstances[0].readyState).toBe(MockWebSocket.CLOSED)
    expect(socketInstances).toHaveLength(2)
    unmount()
  })
  it('restarts a pending authenticated connection after returning from the background',async()=>{
    authState.enabled=true
    let resolveFreshTicket:(url:string)=>void=()=>{}
    getWebSocketUrlMock.mockImplementationOnce(()=>new Promise<string>(()=>{})).mockImplementationOnce(()=>new Promise<string>((resolve)=>{resolveFreshTicket=resolve}))
    const { unmount }=renderHook(() => useWebSocket())
    expect(getWebSocketUrlMock).toHaveBeenCalledTimes(1)
    expect(socketInstances).toHaveLength(0)
    await act(async()=>{
      Object.defineProperty(document,'visibilityState',{ configurable:true, value:'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
      vi.advanceTimersByTime(1201)
      Object.defineProperty(document,'visibilityState',{ configurable:true, value:'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })
    expect(getWebSocketUrlMock).toHaveBeenCalledTimes(2)
    await act(async()=>{
      resolveFreshTicket('ws://localhost:3000/api/stream?ticket=fresh')
      await Promise.resolve()
    })
    expect(socketInstances).toHaveLength(1)
    unmount()
  })
  it('does not interrupt a connecting socket on ordinary focus',()=>{
    const { unmount }=renderHook(() => useWebSocket())
    expect(socketInstances).toHaveLength(1)
    act(()=>{
      window.dispatchEvent(new Event('focus'))
    })
    expect(socketInstances).toHaveLength(1)
    expect(socketInstances[0].readyState).toBe(MockWebSocket.CONNECTING)
    unmount()
  })
  it('replaces a connecting socket only after it has been stale for 8s',()=>{
    const { unmount }=renderHook(() => useWebSocket())
    expect(socketInstances).toHaveLength(1)
    act(()=>{
      vi.advanceTimersByTime(8001)
      window.dispatchEvent(new Event('focus'))
    })
    expect(socketInstances[0].readyState).toBe(MockWebSocket.CLOSED)
    expect(socketInstances).toHaveLength(2)
    unmount()
  })
  it('does not restart a pending authenticated connection on ordinary focus',async()=>{
    authState.enabled=true
    getWebSocketUrlMock.mockImplementation(()=>new Promise<string>(()=>{}))
    const { unmount }=renderHook(() => useWebSocket())
    expect(getWebSocketUrlMock).toHaveBeenCalledTimes(1)
    await act(async()=>{
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })
    expect(getWebSocketUrlMock).toHaveBeenCalledTimes(1)
    expect(socketInstances).toHaveLength(0)
    unmount()
  })
  it('reconnects after a socket error without waiting for close',()=>{
    preferenceState.autoReconnect=true
    const { unmount }=renderHook(() => useWebSocket())
    act(()=>{
      socketInstances[0].error()
      vi.advanceTimersByTime(400)
    })
    expect(socketInstances).toHaveLength(2)
    unmount()
  })
  it('retries when a socket handshake never completes',()=>{
    preferenceState.autoReconnect=true
    const { unmount }=renderHook(() => useWebSocket())
    expect(socketInstances).toHaveLength(1)
    act(()=>{
      vi.advanceTimersByTime(10000)
    })
    expect(socketInstances[0].readyState).toBe(MockWebSocket.CLOSED)
    act(()=>{
      vi.advanceTimersByTime(400)
    })
    expect(socketInstances).toHaveLength(2)
    unmount()
  })
})
