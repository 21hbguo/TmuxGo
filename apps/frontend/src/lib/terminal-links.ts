import type { useTranslation } from '@/i18n'
export const GITHUB_DEVICE_LOGIN_URL = 'https://github.com/login/device'
const ANSI_ESCAPE_REGEX = /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g
const TERMINAL_URL_REGEX = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~\[\]`()<>]/g
const TERMINAL_FILE_LINK_REGEX =
  /(^|[\s([{'"`])((?:\/|\.{1,2}\/|~\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*(?::\d+){0,2})(?=$|[\s)\]}'"`,;.!?，。；、])/g
export type TerminalLineLink =
  | { kind: 'url'; text: string; start: number; end: number; url: string }
  | {
      kind: 'file'
      text: string
      start: number
      end: number
      pathText: string
      line: number | null
      column: number | null
    }
export function normalizeTerminalText(value: string) {
  return value.replace(ANSI_ESCAPE_REGEX, '').replace(/\r/g, '\n')
}
export function extractGithubDeviceLogin(text: string) {
  const codePattern = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/gi
  const urlPattern = /https:\/\/github\.com\/login\/device\b/gi
  let code = ''
  let url = ''
  let match: RegExpExecArray | null
  while ((match = codePattern.exec(text))) code = match[1]?.toUpperCase() || code
  if (!code) return null
  while ((match = urlPattern.exec(text))) url = match[0] || url
  return { code, url: url || GITHUB_DEVICE_LOGIN_URL }
}
export function stripWrappedQuotes(value: string) {
  return value.replace(/^[\s'"([{<]+/, '').replace(/[\s'")\]}>.,;!?，。；、]+$/, '')
}
export function looksLikeFilePath(value: string) {
  if (!value || /^https?:\/\//i.test(value)) return false
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value.startsWith('~/')) return true
  if (value.includes('/')) return true
  if (
    /^(Dockerfile|Makefile|README(?:\.[A-Za-z0-9_-]+)?|LICENSE(?:\.[A-Za-z0-9_-]+)?|\.env(?:\.[A-Za-z0-9_-]+)?)$/.test(
      value,
    )
  )
    return true
  return /^[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]{1,12}$/.test(value)
}
export function openUrlInNewWindow(
  url: string,
  pushToast: (toast: { type: 'success' | 'error' | 'info'; message: string; durationMs?: number }) => void,
  t: ReturnType<typeof useTranslation>['t'],
) {
  const opened = window.open(url, '_blank', 'noopener,noreferrer')
  if (opened) return true
  pushToast({ type: 'error', message: t('terminal.linkOpenBlocked') })
  return false
}
function parseTerminalFileLink(
  text: string,
  start: number,
  end: number,
): Extract<TerminalLineLink, { kind: 'file' }> | null {
  const suffixMatch = text.match(/^(.*?)(?::(\d+))?(?::(\d+))?$/)
  const pathText = stripWrappedQuotes(suffixMatch?.[1] || text)
  if (!pathText || !looksLikeFilePath(pathText)) return null
  return {
    kind: 'file',
    text,
    start,
    end,
    pathText,
    line: suffixMatch?.[2] ? Number(suffixMatch[2]) : null,
    column: suffixMatch?.[3] ? Number(suffixMatch[3]) : null,
  }
}
export function collectTerminalLineLinks(line: string) {
  if (!line) return [] as TerminalLineLink[]
  const urlLinks: TerminalLineLink[] = []
  const urlMatches = Array.from(line.matchAll(new RegExp(TERMINAL_URL_REGEX.source, 'g')))
  for (const match of urlMatches) {
    const text = match[0] || ''
    const start = match.index ?? -1
    if (!text || start < 0) continue
    urlLinks.push({ kind: 'url', text, start, end: start + text.length, url: text })
  }
  const fileLinks: TerminalLineLink[] = []
  const fileMatches = Array.from(line.matchAll(new RegExp(TERMINAL_FILE_LINK_REGEX.source, 'g')))
  for (const match of fileMatches) {
    const text = match[2] || ''
    const prefix = match[1] || ''
    const start = (match.index ?? -1) + prefix.length
    if (!text || start < 0) continue
    const end = start + text.length
    if (urlLinks.some((item) => start < item.end && end > item.start)) continue
    const parsed = parseTerminalFileLink(text, start, end)
    if (parsed) fileLinks.push(parsed)
  }
  return [...urlLinks, ...fileLinks].sort((a, b) => a.start - b.start || (a.kind === 'url' ? -1 : 1))
}
