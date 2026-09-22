const ANSI_ESCAPE_REGEX = /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\([ -~]|\)[ -~]|\][^\u0007]*(?:\u0007|\u001b\\))/g
const CONTROL_CHAR_REGEX = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
const TMUX_STATUS_LINE_PATTERNS = [/^\[[^\]]*:\d+:[^\]]+\*?[^\]]*$/, /^\[[^\]]*".*"\s+\d{1,2}:\d{2}\s+\d{2}-.*$/]
function isLikelyTmuxStatusLine(line: string) {
  const value = line.trim()
  if (!value.startsWith('[')) return false
  return TMUX_STATUS_LINE_PATTERNS.some((pattern) => pattern.test(value))
}
export function stripTerminalControlSequences(value: string) {
  return value.replace(ANSI_ESCAPE_REGEX, '').replace(CONTROL_CHAR_REGEX, '')
}
export function getVisibleTerminalLines(value: string) {
  return stripTerminalControlSequences(value)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
}
export function hasVisibleTerminalContent(value: string) {
  return getVisibleTerminalLines(value).length > 0
}
export function hasSubstantiveTerminalContent(value: string) {
  const lines = getVisibleTerminalLines(value)
  if (!lines.length) return false
  return lines.some((line) => !isLikelyTmuxStatusLine(line))
}
// DA（Device Attributes）应答：CSI ... c，如 \u001b?1;2c / \u001b0;1c。
// 非显示序列，会污染前端 xterm——light/heavy 两条路径都必须剥掉。
const DA_REPLY_REGEX = /\u001b\[[0-9;?]*c/g
// 历史噪音（heavy 专属）：不带 ESC[ 前缀的裸 digits;c 形态，来自早期坏解析残留。
// light 不跑它们——见 createTerminalOutputSanitizer 内注释。
const NOISE_BARE_PARAMS_C = /(?:\u001b\[)?\??(?:\d+;)+\d+c/g
const NOISE_ZERO_PREFIX_C = /0;(?:\d+;)*\d+c/g
export type TerminalSanitizeMode = 'light' | 'heavy'
export function createTerminalOutputSanitizer() {
  let carry = ''
  // 为什么 light 不做全量正则：
  // onData 热路径每个 output chunk 都会进这里；heavy 的多次全局 replace +
  // 尾部 digits;c 匹配在刷屏时是纯 CPU 税（metrics: sanitizeCalls/sanitizeChars）。
  // light 只处理「必然污染 xterm 的 DA 应答」+ 跨 chunk 尾部不完整 CSI carry；
  // 完整噪音清洗只在 resync/attach 边界（heavy 模式）跑一次，稳态刷屏零负担。
  return (chunk: string, mode: TerminalSanitizeMode = 'light') => {
    const input = carry + chunk
    if (mode === 'light') {
      // 只剥 DA 应答；ANSI/颜色/中文等可显示内容原样通过，不跑历史噪音正则
      const cleaned = input.replace(DA_REPLY_REGEX, '')
      // 尾部不完整 ESC/CSI 必须 carry，避免截断半个序列到下一 chunk
      const trailingEsc = cleaned.match(/\u001b(?:\[[0-9;?]*)?$/)
      if (trailingEsc && trailingEsc[0]) {
        carry = trailingEsc[0]
        return cleaned.slice(0, cleaned.length - trailingEsc[0].length)
      }
      carry = ''
      return cleaned
    }
    // heavy：边界（resync / 新 attach / sanitizer 重建）完整清洗——含历史噪音形态
    const cleaned = input.replace(DA_REPLY_REGEX, '').replace(NOISE_BARE_PARAMS_C, '').replace(NOISE_ZERO_PREFIX_C, '')
    const trailingEsc = cleaned.match(/\u001b(?:\[[0-9;?]*)?$/)
    const trailingDigits = cleaned.match(/[0-9;]{0,32}c?$/)
    if (trailingEsc && trailingEsc[0]) {
      carry = trailingEsc[0]
      return cleaned.slice(0, cleaned.length - trailingEsc[0].length)
    }
    if (
      trailingDigits &&
      trailingDigits[0] &&
      trailingDigits[0].includes(';') &&
      trailingDigits[0].length < cleaned.length
    ) {
      carry = trailingDigits[0]
      return cleaned.slice(0, cleaned.length - trailingDigits[0].length)
    }
    carry = ''
    return cleaned
  }
}
