import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SWITCH_HUD_DURATION_MS,
  SWITCH_HUD_LABEL_LIMIT,
  SWITCH_HUD_MAX_SEGMENTS,
  SwitchHud,
  type SwitchHudPayload,
} from './SwitchHud'

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
    // 分段位置条：3 段，当前段（第 2 个）唯一高亮
    const bar = screen.getByTestId('switch-hud-window-bar')
    expect(bar.children).toHaveLength(3)
    expect(bar.dataset.total).toBe('3')
    const active = screen.getByTestId('switch-hud-window-bar-active')
    expect(active.className).toContain('bg-accent')
    expect(active.className).toContain('w-4')
    expect(bar.querySelectorAll('[data-testid$="-active"]')).toHaveLength(1)
    // 相邻刻度是灰短段
    const idle = [...bar.children].find((child) => child !== active)!
    expect(idle.className).toContain('bg-white/25')
    // 非 zoom 态不显示 pane 行
    expect(screen.queryByTestId('switch-hud-pane')).toBeNull()
  })

  it('adds the pane position only when zoomed pane switching provides it', () => {
    render(<SwitchHud payload={windowHud({ paneIndex: 1, paneTotal: 2, prevLabel: '#2', nextLabel: '#3' })} />)
    expect(screen.getByTestId('switch-hud-pane').textContent).toBe('面板 1/2')
    // zoom 态另有一条 pane 段条，用 accent-2 与窗口条区分
    const paneBar = screen.getByTestId('switch-hud-pane-bar')
    expect(paneBar.children).toHaveLength(2)
    expect(screen.getByTestId('switch-hud-pane-bar-active').className).toContain('bg-accent-2')
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

  it('drops the segment bar for long lists and keeps the text position', () => {
    render(<SwitchHud payload={windowHud({ windowIndex: 5, windowTotal: SWITCH_HUD_MAX_SEGMENTS + 1 })} />)
    // 段太多反而难读：>8 只留 n/total 文本
    expect(screen.queryByTestId('switch-hud-window-bar')).toBeNull()
    expect(screen.getByTestId('switch-hud-position').textContent).toContain(`窗口 5/${SWITCH_HUD_MAX_SEGMENTS + 1}`)
  })

  it('keeps a single-target bar hidden but still renders the position', () => {
    render(
      <SwitchHud payload={windowHud({ windowIndex: 1, windowTotal: 1, prevLabel: undefined, nextLabel: undefined })} />,
    )
    expect(screen.queryByTestId('switch-hud-window-bar')).toBeNull()
    expect(screen.getByTestId('switch-hud-position').textContent).toContain('窗口 1/1')
  })

  it('clips long neighbour names so the main row stays on one line', () => {
    const long = 'a-very-long-window-name'
    render(<SwitchHud payload={windowHud({ prevLabel: long, nextLabel: long })} />)
    const clipped = `${long.slice(0, SWITCH_HUD_LABEL_LIMIT)}…`
    expect(screen.getByTestId('switch-hud-prev').textContent).toBe(`← ${clipped}`)
    expect(screen.getByTestId('switch-hud-next').textContent).toBe(`${clipped} →`)
    // 主行不折行，窄屏靠 CSS 继续收窄
    expect(screen.getByTestId('switch-hud-position').parentElement?.className).toContain('whitespace-nowrap')
  })

  it('fades and lifts in on mount, so the layer is not a hard cut', () => {
    render(<SwitchHud payload={windowHud()} />)
    const card = screen.getByTestId('switch-hud-card')
    // 首帧是位移+透明初态，transition 类负责补间
    expect(card.className).toContain('translate-y-1')
    expect(card.className).toContain('opacity-0')
    expect(card.className).toContain('transition-all')
    act(() => {
      // 下一帧切到终态，交给 transition 补间
      vi.advanceTimersToNextFrame()
    })
    const entered = screen.getByTestId('switch-hud-card')
    expect(entered.className).toContain('translate-y-0')
    expect(entered.className).toContain('opacity-100')
  })

  it('renders nothing without a payload', () => {
    render(<SwitchHud payload={null} />)
    expect(screen.queryByTestId('switch-hud')).toBeNull()
  })
})
