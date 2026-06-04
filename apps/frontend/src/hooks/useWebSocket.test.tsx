import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWebSocket } from './useWebSocket'
const updateConnectionMock=vi.fn()
const preferenceState={autoReconnect:false,reconnectInterval:1000}
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
vi.mock('@/lib/mobile-diagnostics',()=>({
  recordMobileDiagnostic:vi.fn(),
}))
describe('useWebSocket',()=>{
  beforeEach(()=>{
    vi.useFakeTimers()
    updateConnectionMock.mockReset()
    preferenceState.autoReconnect=false
    preferenceState.reconnectInterval=1000
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
})
