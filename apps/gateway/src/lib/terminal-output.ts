const ANSI_ESCAPE_REGEX=/\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\([ -~]|\)[ -~]|\][^\u0007]*(?:\u0007|\u001b\\))/g
const CONTROL_CHAR_REGEX=/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
const TMUX_STATUS_LINE_PATTERNS=[
  /^\[[^\]]*:\d+:[^\]]+\*?[^\]]*$/,
  /^\[[^\]]*".*"\s+\d{1,2}:\d{2}\s+\d{2}-.*$/,
]
function isLikelyTmuxStatusLine(line:string) {
  const value=line.trim()
  if (!value.startsWith('[')) return false
  return TMUX_STATUS_LINE_PATTERNS.some((pattern)=>pattern.test(value))
}
export function stripTerminalControlSequences(value:string) {
  return value.replace(ANSI_ESCAPE_REGEX,'').replace(CONTROL_CHAR_REGEX,'')
}
export function getVisibleTerminalLines(value:string) {
  return stripTerminalControlSequences(value).split('\n').map((line)=>line.trimEnd()).filter((line)=>line.trim().length>0)
}
export function hasVisibleTerminalContent(value:string) {
  return getVisibleTerminalLines(value).length>0
}
export function hasSubstantiveTerminalContent(value:string) {
  const lines=getVisibleTerminalLines(value)
  if (!lines.length) return false
  return lines.some((line)=>!isLikelyTmuxStatusLine(line))
}
