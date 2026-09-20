import { recordMobileDebug } from './terminal-debug'
const RESIZE_MASK_FAILSAFE_MS = 900
interface TerminalResizeMaskOptions {
  mask: HTMLElement | null
  getTerminal: () => any
  onPendingChange?: (pending: boolean) => void
}
export function createTerminalResizeMask(options: TerminalResizeMaskOptions) {
  let revealFrame: number | null = null
  let failsafeTimer: ReturnType<typeof setTimeout> | null = null
  let generation = 0
  let pending = false
  const setPending = (value: boolean) => {
    pending = value
    options.onPendingChange?.(value)
  }
  const reveal = (targetGeneration = generation) => {
    if (targetGeneration !== generation) return
    if (failsafeTimer) {
      clearTimeout(failsafeTimer)
      failsafeTimer = null
    }
    if (revealFrame) cancelAnimationFrame(revealFrame)
    let synchronous = true
    const frame = requestAnimationFrame(() => {
      revealFrame = null
      if (targetGeneration !== generation) return
      let nextSynchronous = true
      const nextFrame = requestAnimationFrame(() => {
        revealFrame = null
        if (targetGeneration !== generation) return
        setPending(false)
        const mask = options.mask
        if (mask) {
          mask.style.display = 'none'
          mask.replaceChildren()
        }
        nextSynchronous = false
      })
      if (nextSynchronous) revealFrame = nextFrame
      synchronous = false
    })
    if (synchronous) revealFrame = frame
  }
  let lastCaptureMaskW = 0
  let lastCaptureMaskH = 0
  const show = () => {
    if (revealFrame) cancelAnimationFrame(revealFrame)
    revealFrame = null
    if (failsafeTimer) clearTimeout(failsafeTimer)
    const nextGeneration = generation + 1
    failsafeTimer = setTimeout(() => {
      failsafeTimer = null
      recordMobileDebug('terminal-resize-mask-failsafe', { generation: nextGeneration })
      reveal(nextGeneration)
    }, RESIZE_MASK_FAILSAFE_MS)
    generation = nextGeneration
    setPending(true)
    const mask = options.mask
    if (mask) {
      // 显示中再次 show（离散连跳/容器继续变）：几何变了必须重截，
      // 否则克隆按旧 rect 挂在新尺寸的 mask 里——整帧偏移错位
      const stale =
        mask.style.display === 'block' &&
        (Math.abs(mask.clientWidth - lastCaptureMaskW) > 1 || Math.abs(mask.clientHeight - lastCaptureMaskH) > 1)
      if (mask.style.display !== 'block' || stale) {
        mask.style.display = 'block'
        captureSnapshot()
      }
    }
    return generation
  }
  const captureSnapshot = () => {
    const mask = options.mask
    const terminal = options.getTerminal()
    if (!mask) return
    const screen = terminal?.element?.querySelector('.xterm-screen') as HTMLElement | null
    if (!screen) return
    const snapshot = screen.cloneNode(true) as HTMLElement
    const screenRect = screen.getBoundingClientRect()
    const maskRect = mask.getBoundingClientRect()
    snapshot.style.setProperty('inset', 'auto', 'important')
    snapshot.style.setProperty('left', `${screenRect.left - maskRect.left}px`, 'important')
    // 克隆必须贴在 screen 的真实 top（rect 已含 transform）：底部锚定
    // maskH-screenH 只在 screen 底边恰好贴 mask 底边时等价——shared/非独占
    // 模式下 screen 高度按行数走、不填满容器，底锚会把整帧下移、逐行出格。
    // 唯一例外：screen 底边溢出 mask（容器已变矮、screen 还没跟上），上移
    // 溢出量保住底部 prompt 行，与 tmux reflow 方向一致
    const topOffset = screenRect.top - maskRect.top
    const bottomOverflow = screenRect.bottom - maskRect.bottom
    snapshot.style.setProperty('top', `${bottomOverflow > 1 ? topOffset - bottomOverflow : topOffset}px`, 'important')
    snapshot.style.setProperty('width', `${screenRect.width}px`, 'important')
    snapshot.style.setProperty('height', `${screenRect.height}px`, 'important')
    // 源 screen 若带键盘裁剪 transform，偏移已计入 rect；克隆再应用会二次平移
    snapshot.style.removeProperty('transform')
    snapshot.style.removeProperty('transform-origin')
    snapshot.style.removeProperty('will-change')
    lastCaptureMaskW = mask.clientWidth
    lastCaptureMaskH = mask.clientHeight
    const sourceCanvases = Array.from(screen.querySelectorAll('canvas'))
    const snapshotCanvases = Array.from(snapshot.querySelectorAll('canvas'))
    sourceCanvases.forEach((source, index) => {
      try {
        snapshotCanvases[index]?.getContext('2d')?.drawImage(source, 0, 0)
      } catch {}
    })
    mask.replaceChildren(snapshot)
  }
  const hide = () => {
    setPending(false)
    const mask = options.mask
    if (mask) {
      mask.style.display = 'none'
      mask.replaceChildren()
    }
  }
  const isVisible = () => options.mask?.style.display === 'block'
  const dispose = () => {
    if (revealFrame) cancelAnimationFrame(revealFrame)
    if (failsafeTimer) {
      clearTimeout(failsafeTimer)
      failsafeTimer = null
    }
    setPending(false)
    options.mask?.replaceChildren()
  }
  return {
    show,
    reveal,
    hide,
    isVisible,
    dispose,
    isPending: () => pending,
    getGeneration: () => generation,
  }
}
