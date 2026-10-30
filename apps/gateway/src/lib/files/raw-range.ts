export type ParsedRange = { start: number; end: number } | null | 'invalid'

// 只接单段 bytes 语法：媒体元素（<video>/<audio>）只会发单段，
// 多段需要我们拼 multipart/byteranges，收益低且容易写出越界响应，直接回落 200 全量。
const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/

/**
 * 解析单段 Range（RFC 9110 §14）。
 * - null：无 Range / 语法非法 / 多段 → 按 200 全量处理
 * - 'invalid'：语法合法但不可满足 → 416
 */
export function parseSingleRange(header: string | undefined, size: number): ParsedRange {
  if (!header) return null
  const raw = header.trim()
  if (!raw) return null
  if (raw.includes(',')) return null
  const match = SINGLE_RANGE.exec(raw.toLowerCase())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  // "bytes=-" 两端都空：语法非法而非不可满足
  if (rawStart === '' && rawEnd === '') return null
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    // 后缀长度 0 无意义；0 字节文件任何区间都不可满足
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    if (size <= 0) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(rawStart)
  // 超出 Number 安全范围的数字串语法合法但必然越界，按不可满足处理
  if (!Number.isFinite(start)) return 'invalid'
  if (rawEnd === '') {
    if (start >= size) return 'invalid'
    return { start, end: size - 1 }
  }
  const end = Number(rawEnd)
  if (!Number.isFinite(end)) return 'invalid'
  if (start > end) return 'invalid'
  if (start >= size) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}
