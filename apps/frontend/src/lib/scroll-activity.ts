const SCROLL_IDLE_MS = 700
const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>()
if (typeof document !== 'undefined') {
  document.addEventListener('scroll', (event) => {
    const target = event.target
    const el = target instanceof Document ? target.documentElement : target instanceof Element ? target : null
    if (!el) return
    el.classList.add('tmuxgo-scrolling')
    const prev = timers.get(el)
    if (prev) clearTimeout(prev)
    timers.set(el, setTimeout(() => {
      timers.delete(el)
      el.classList.remove('tmuxgo-scrolling')
    }, SCROLL_IDLE_MS))
  }, { capture: true, passive: true })
}
