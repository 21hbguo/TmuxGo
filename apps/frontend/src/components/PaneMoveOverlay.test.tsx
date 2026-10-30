import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaneMoveOverlay } from './PaneMoveOverlay'
import { PANE_DRAG_MIME, getPaneDrag, resetPaneDrag, startPaneDrag } from '@/lib/pane-drag'
import type { Pane } from '@/types'

vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const SRC = 'local:%1'
const TARGET = 'local:%2'

function pane(overrides: Partial<Pane> & Pick<Pane, 'id'>): Pane {
  return {
    windowId: 'local:@1',
    index: 0,
    title: 'shell',
    active: false,
    left: 0,
    top: 0,
    size: { cols: 80, rows: 24 },
    ...overrides,
  } as Pane
}

const panes = [
  pane({ id: SRC, index: 0, title: 'left', active: true, left: 0, top: 0, size: { cols: 80, rows: 24 } }),
  pane({ id: TARGET, index: 1, title: 'right', left: 80, top: 0, size: { cols: 80, rows: 24 } }),
]

function createDataTransfer(paneId: string) {
  const payload: Record<string, string> = { [PANE_DRAG_MIME]: JSON.stringify({ paneId, windowId: 'local:@1' }) }
  return {
    effectAllowed: 'all',
    dropEffect: 'none',
    types: Object.keys(payload),
    setData: vi.fn(),
    getData: (type: string) => payload[type] || '',
  } as unknown as DataTransfer
}

function stubRect(el: Element, rect: { left: number; top: number; width: number; height: number }) {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
    }),
  })
}

// jsdom 没有 DragEvent 构造器：用 Event + 手动挂 dataTransfer/坐标，与 EditorWorkbench 测试同一套写法
function dispatchDrag(
  target: Element,
  type: 'dragover' | 'drop' | 'dragleave',
  dataTransfer: DataTransfer,
  coords: { x: number; y: number },
  relatedTarget?: Element,
) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  Object.defineProperty(event, 'clientX', { value: coords.x })
  Object.defineProperty(event, 'clientY', { value: coords.y })
  if (relatedTarget) Object.defineProperty(event, 'relatedTarget', { value: relatedTarget })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

describe('PaneMoveOverlay', () => {
  afterEach(() => {
    cleanup()
    resetPaneDrag()
  })

  it('renders one drop region per other pane and skips the dragged pane', () => {
    startPaneDrag({ paneId: SRC })
    render(<PaneMoveOverlay panes={panes} dragPaneId={SRC} onMove={vi.fn()} />)
    expect(screen.getByTestId('pane-move-overlay')).toBeInTheDocument()
    expect(screen.getByTestId(`pane-drop-${TARGET}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`pane-drop-${SRC}`)).toBeNull()
  })

  it('highlights the right half and moves with direction=horizontal', () => {
    const onMove = vi.fn()
    startPaneDrag({ paneId: SRC })
    render(<PaneMoveOverlay panes={panes} dragPaneId={SRC} onMove={onMove} />)
    const region = screen.getByTestId(`pane-drop-${TARGET}`)
    stubRect(region, { left: 0, top: 0, width: 200, height: 100 })
    const dataTransfer = createDataTransfer(SRC)

    dispatchDrag(region, 'dragover', dataTransfer, { x: 180, y: 50 })
    expect(region.getAttribute('data-active-side')).toBe('right')
    expect(screen.getByTestId(`pane-drop-hint-${TARGET}`).getAttribute('data-side')).toBe('right')

    dispatchDrag(region, 'drop', dataTransfer, { x: 180, y: 50 })
    expect(onMove).toHaveBeenCalledWith(SRC, TARGET, 'horizontal')
    // drop 之后单例要散场，否则落点层会一直挂着
    expect(getPaneDrag()).toBeNull()
  })

  it('maps the top half to direction=vertical', () => {
    const onMove = vi.fn()
    startPaneDrag({ paneId: SRC })
    render(<PaneMoveOverlay panes={panes} dragPaneId={SRC} onMove={onMove} />)
    const region = screen.getByTestId(`pane-drop-${TARGET}`)
    stubRect(region, { left: 0, top: 0, width: 200, height: 100 })
    const dataTransfer = createDataTransfer(SRC)

    dispatchDrag(region, 'dragover', dataTransfer, { x: 100, y: 5 })
    expect(region.getAttribute('data-active-side')).toBe('top')
    dispatchDrag(region, 'drop', dataTransfer, { x: 100, y: 5 })
    expect(onMove).toHaveBeenCalledWith(SRC, TARGET, 'vertical')
  })

  it('clears the highlight when the pointer leaves the region', () => {
    startPaneDrag({ paneId: SRC })
    render(<PaneMoveOverlay panes={panes} dragPaneId={SRC} onMove={vi.fn()} />)
    const region = screen.getByTestId(`pane-drop-${TARGET}`)
    stubRect(region, { left: 0, top: 0, width: 200, height: 100 })
    dispatchDrag(region, 'dragover', createDataTransfer(SRC), { x: 180, y: 50 })
    expect(region.getAttribute('data-active-side')).toBe('right')
    dispatchDrag(region, 'dragleave', createDataTransfer(SRC), { x: 0, y: 0 })
    expect(region.getAttribute('data-active-side')).toBeNull()
  })

  it('ignores drags that are not pane drags (files/text must not move panes)', () => {
    const onMove = vi.fn()
    startPaneDrag({ paneId: SRC })
    render(<PaneMoveOverlay panes={panes} dragPaneId={SRC} onMove={onMove} />)
    const region = screen.getByTestId(`pane-drop-${TARGET}`)
    stubRect(region, { left: 0, top: 0, width: 200, height: 100 })
    const fileTransfer = {
      types: ['application/x-tmuxgo-file'],
      getData: () => '',
      setData: vi.fn(),
      effectAllowed: 'all',
      dropEffect: 'copy',
    } as unknown as DataTransfer
    // 单例已被 reset（没有进行中的 pane 拖拽）时，非 pane MIME 不得触发移动
    resetPaneDrag()
    dispatchDrag(region, 'drop', fileTransfer, { x: 180, y: 50 })
    expect(onMove).not.toHaveBeenCalled()
  })

  it('does not render anything when the window has a single pane', () => {
    startPaneDrag({ paneId: SRC })
    render(<PaneMoveOverlay panes={[panes[0]]} dragPaneId={SRC} onMove={vi.fn()} />)
    expect(screen.queryByTestId('pane-move-overlay')).toBeNull()
  })
})
