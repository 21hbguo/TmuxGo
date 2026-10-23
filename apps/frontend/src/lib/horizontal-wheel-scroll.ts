// 横向条（tab 条/chip 行/面包屑）只有横向溢出：浏览器不会把纵向滚轮折算成横向滚动
// （仅 shift+滚轮原生支持），需手动把主轴 delta 写进 scrollLeft。React 根委托的 wheel
// 是 passive，preventDefault 只能走原生非 passive 监听；WeakSet 防重渲重复绑定
const wheelBound = new WeakSet<Element>()
export function bindHorizontalWheelScroll(el: HTMLElement | null) {
  if (!el || wheelBound.has(el)) return
  wheelBound.add(el)
  el.addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey || event.metaKey) return
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      if (!delta) return
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientWidth : 1
      const max = el.scrollWidth - el.clientWidth
      if (max <= 0) return
      const next = Math.min(Math.max(el.scrollLeft + delta * unit, 0), max)
      if (next === el.scrollLeft) return // 已到边界：放行给滚动链
      event.preventDefault()
      el.scrollLeft = next
    },
    { passive: false },
  )
}
