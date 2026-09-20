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
    if (mask && mask.style.display !== 'block') {
      mask.style.display = 'block'
      captureSnapshot()
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
    // 底部锚定：容器变矮时保住 prompt 行不被裁掉，变高时留白在上方——
    // 与 tmux reflow 的方向一致（grow 从 scrollback 往上拉行、光标留在底部）
    snapshot.style.setProperty('top', `${maskRect.height - screenRect.height}px`, 'important')
    snapshot.style.setProperty('width', `${screenRect.width}px`, 'important')
    snapshot.style.setProperty('height', `${screenRect.height}px`, 'important')
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
