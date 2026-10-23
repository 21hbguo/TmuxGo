import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SWITCH_HUD_DURATION_MS, SwitchHud, type SwitchHudPayload } from './SwitchHud'

// 用真 i18n 词表断言用户可见文案（不是 key），插值逻辑照 index.tsx 的 t() 走
vi.mock('@/i18n', async () => {
  const { zh } = await import('@/i18n/zh')
  return {
    useTranslation: () => ({
      language: 'zh',
      t: (key: string, params?: Record<string, string | number>) => {
        let text = (zh as Record<string, string>)[key] ?? key
        for (const [k, v] of Object.entries(params ?? {})) text = text.replace(`{${k}}`, String(v))
        return text
      },
    }),
  }
})

const windowHud = (over: Partial<SwitchHudPayload> = {}): SwitchHudPayload => ({
  windowIndex: 2,
  windowTotal: 3,
  windowName: 'dev',
  prevLabel: 'ops',
  nextLabel: 'logs',
  ...over,
})

describe('SwitchHud', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows current window position, name and both neighbours', () => {
    render(<SwitchHud payload={windowHud()} />)
    const hud = screen.getByTestId('switch-hud')
    // 非交互覆盖层：不吃手势
    expect(hud.className).toContain('pointer-events-none')
    expect(screen.getByTestId('switch-hud-position').textContent).toContain('窗口 2/3')
    expect(screen.getByTestId('switch-hud-position').textContent).toContain('dev')
    expect(screen.getByTestId('switch-hud-prev').textContent).toBe('← ops')
    expect(screen.getByTestId('switch-hud-next').textContent).toBe('logs →')
    // 非 zoom 态不显示 pane 行
    expect(screen.queryByTestId('switch-hud-pane')).toBeNull()
  })

  it('adds the pane position only when zoomed pane switching provides it', () => {
    render(<SwitchHud payload={windowHud({ paneIndex: 1, paneTotal: 2, prevLabel: '#2', nextLabel: '#3' })} />)
    expect(screen.getByTestId('switch-hud-pane').textContent).toBe('面板 1/2')
    expect(screen.getByTestId('switch-hud-prev').textContent).toBe('← #2')
    expect(screen.getByTestId('switch-hud-next').textContent).toBe('#3 →')
  })

  it('omits the arrow on the side with no neighbour', () => {
    render(<SwitchHud payload={windowHud({ windowIndex: 1, prevLabel: undefined, nextLabel: 'ops' })} />)
    expect(screen.queryByTestId('switch-hud-prev')).toBeNull()
    expect(screen.getByTestId('switch-hud-next').textContent).toBe('ops →')
  })

  it('auto-hides after the flash window', () => {
    render(<SwitchHud payload={windowHud()} />)
    expect(screen.getByTestId('switch-hud')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(SWITCH_HUD_DURATION_MS - 100)
    })
    expect(screen.queryByTestId('switch-hud')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(screen.queryByTestId('switch-hud')).toBeNull()
  })

  it('restarts the timer on a follow-up switch instead of stacking layers', () => {
    const { rerender } = render(<SwitchHud payload={windowHud()} />)
    act(() => {
      vi.advanceTimersByTime(SWITCH_HUD_DURATION_MS - 100)
    })
    rerender(<SwitchHud payload={windowHud({ windowIndex: 3, windowName: 'logs' })} />)
    // 上一轮剩余寿命作废：再过 500ms 仍在，且只有一层
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(screen.getAllByTestId('switch-hud')).toHaveLength(1)
    expect(screen.getByTestId('switch-hud-position').textContent).toContain('窗口 3/3')
    act(() => {
      vi.advanceTimersByTime(SWITCH_HUD_DURATION_MS)
    })
    expect(screen.queryByTestId('switch-hud')).toBeNull()
  })

  it('renders nothing without a payload', () => {
    render(<SwitchHud payload={null} />)
    expect(screen.queryByTestId('switch-hud')).toBeNull()
  })
})
