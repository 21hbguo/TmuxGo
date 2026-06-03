import { act, render } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionContinuity } from './useSessionContinuity'

const getMock=vi.fn()
const updateMock=vi.fn()
let hookState:ReturnType<typeof useSessionContinuity>|null=null

vi.mock('@/lib/api',()=>({
  api:{
    preferences:{
      get:(...args:unknown[])=>getMock(...args),
      update:(...args:unknown[])=>updateMock(...args),
    },
  },
}))

function TestComponent() {
  hookState=useSessionContinuity()
  return React.createElement('div')
}

describe('useSessionContinuity',()=>{
  beforeEach(()=>{
    vi.useFakeTimers()
    vi.clearAllMocks()
    localStorage.clear()
    hookState=null
    updateMock.mockResolvedValue({})
    getMock.mockResolvedValue({
      sessionContinuity:{
        enabled:true,
        syncToServer:true,
        resumeOnReconnect:true,
        resumeOnNewDevice:true,
        maxResumePoints:20,
        archive:{enabled:false,captureMode:'none',maxBytesPerSession:262144,retentionDays:7},
        resumePoints:[],
        updatedAt:'2026-06-03T00:00:00.000Z',
      },
      sessionContinuityUpdatedAt:'2026-06-03T00:00:00.000Z',
    })
  })

  it('coalesces rapid resume point updates into one remote write',async()=>{
    render(React.createElement(TestComponent))
    await act(async()=>{
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(updateMock).not.toHaveBeenCalled()
    expect(hookState).not.toBeNull()
    await act(async()=>{
      hookState!.upsertResumePoint({hostId:'local',sessionId:'session-a',sessionName:'session-a',windowId:null,paneId:null,cols:120,rows:36,exclusive:true})
      vi.advanceTimersByTime(100)
      await Promise.resolve()
      hookState!.upsertResumePoint({hostId:'local',sessionId:'session-a',sessionName:'session-a',windowId:null,paneId:null,cols:121,rows:36,exclusive:true})
      vi.advanceTimersByTime(100)
      await Promise.resolve()
      hookState!.upsertResumePoint({hostId:'local',sessionId:'session-a',sessionName:'session-a',windowId:null,paneId:null,cols:122,rows:36,exclusive:true})
      vi.advanceTimersByTime(1200)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(updateMock).toHaveBeenCalledTimes(1)
    expect(updateMock.mock.calls[0][0]).toMatchObject({
      sessionContinuity:{
        resumePoints:[
          expect.objectContaining({hostId:'local',sessionId:'session-a',cols:122,rows:36}),
        ],
      },
    })
  })
})
