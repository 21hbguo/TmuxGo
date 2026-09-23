// Monaco 原生滚轮把 delta 归一化（像素 /40、LINE 模式取原值）后乘固定 50px，
// 不同平台"一格滚轮"实际滚动行数差异很大（Linux Chrome 一格约 53px → 仅 ~1.3 行）。
// 这里按 Monaco MouseWheelClassifier 同款启发式识别物理滚轮：命中时由我们按固定行数滚动，
// 触控板/惯性滚动事件放行给 Monaco 原生管线，触控板手感保持不变。

const CLASSIFIER_CAPACITY = 5
const DOM_DELTA_LINE = 1

interface WheelSample {
  deltaX: number
  deltaY: number
  score: number
}

const isAlmostInt = (value: number) => Math.abs(Math.round(value) - value) < 0.01 + Number.EPSILON * 100

// 与 Monaco StandardWheelEvent 同口径归一：LINE 模式 delta 本身是行，PIXEL 按 40px/单位
const normalizeDelta = (delta: number, deltaMode: number) => (deltaMode === DOM_DELTA_LINE ? delta : delta / 40)

// 与 Monaco 一致：评分趋 0 = 物理滚轮，趋 1 = 触控板等连续输入
function scoreSample(item: WheelSample, previous: WheelSample | null) {
  if (Math.abs(item.deltaX) > 0 && Math.abs(item.deltaY) > 0) return 1
  let score = 0.5
  if (!isAlmostInt(item.deltaX) || !isAlmostInt(item.deltaY)) score += 0.25
  // 非加速滚动特征：相邻事件幅度互为整数倍（滚轮每格幅度恒定）
  if (previous) {
    const minX = Math.max(Math.min(Math.abs(item.deltaX), Math.abs(previous.deltaX)), 1)
    const minY = Math.max(Math.min(Math.abs(item.deltaY), Math.abs(previous.deltaY)), 1)
    const maxX = Math.max(Math.abs(item.deltaX), Math.abs(previous.deltaX))
    const maxY = Math.max(Math.abs(item.deltaY), Math.abs(previous.deltaY))
    if (maxX % minX === 0 && maxY % minY === 0) score -= 0.5
  }
  return Math.min(Math.max(score, 0), 1)
}

export class PhysicalWheelClassifier {
  private samples: WheelSample[] = []

  accept(deltaX: number, deltaY: number, deltaMode: number) {
    const sample: WheelSample = {
      deltaX: normalizeDelta(deltaX, deltaMode),
      deltaY: normalizeDelta(deltaY, deltaMode),
      score: 0,
    }
    sample.score = scoreSample(sample, this.samples[this.samples.length - 1] ?? null)
    this.samples.push(sample)
    if (this.samples.length > CLASSIFIER_CAPACITY) this.samples.shift()
  }

  // 最近事件加权评分（最新 0.5、次新 0.25…最老补足剩余权重），≤0.5 判物理滚轮
  isPhysicalMouseWheel() {
    let remaining = 1
    let score = 0
    let iteration = 1
    for (let index = this.samples.length - 1; index >= 0; index--) {
      const influence = index === 0 ? remaining : Math.pow(2, -iteration)
      remaining -= influence
      score += this.samples[index].score * influence
      iteration++
    }
    return score <= 0.5
  }
}

export interface WheelScrollTarget {
  getScrollTop(): number
  getMaxScrollTop(): number
  getLineHeight(): number
  setScrollTop(top: number): void
}

// 返回 dispose 函数。getLines() <=0 表示"默认"，完全放行给 Monaco
export function attachWheelScrollLines(dom: HTMLElement, getLines: () => number, target: WheelScrollTarget) {
  const classifier = new PhysicalWheelClassifier()
  // 平滑滚动动画期间 getScrollTop 是中间值；连续滚轮要从未完成的目标位置继续累加
  let pending: { value: number; expiresAt: number } | null = null
  const scrollByLines = (deltaLines: number) => {
    const now = Date.now()
    const base = pending && pending.expiresAt > now ? pending.value : target.getScrollTop()
    const next = Math.min(target.getMaxScrollTop(), Math.max(0, base + deltaLines * target.getLineHeight()))
    pending = { value: next, expiresAt: now + 300 }
    target.setScrollTop(next)
  }
  const onWheel = (event: WheelEvent) => {
    const lines = getLines()
    if (!lines || lines <= 0) return
    // 修饰键场景交回 Monaco：Ctrl/Cmd=字号缩放，Shift=横向滚动，Alt=快速滚动
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    if (!event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
    classifier.accept(event.deltaX, event.deltaY, event.deltaMode)
    if (!classifier.isPhysicalMouseWheel()) return
    event.preventDefault()
    event.stopPropagation()
    scrollByLines(Math.sign(event.deltaY) * lines)
  }
  // Monaco 的滚轮监听挂在内部 scrollable 节点上（冒泡阶段）；在外层 capture 拦截才能先于它消费
  dom.addEventListener('wheel', onWheel, { capture: true, passive: false })
  return () => dom.removeEventListener('wheel', onWheel, { capture: true })
}
