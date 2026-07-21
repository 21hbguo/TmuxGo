'use client'
import { useMemo } from 'react'
import { useGitDiff } from '@/hooks/useApi'
import { useTranslation } from '@/i18n'

interface DiffLine {
  type: 'header' | 'hunk' | 'add' | 'del' | 'context'
  content: string
  oldLine?: number
  newLine?: number
}

function parseDiff(raw: string): DiffLine[] {
  const lines = raw.split('\n')
  const result: DiffLine[] = []
  let oldLine = 0
  let newLine = 0

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/)
      if (match) {
        oldLine = parseInt(match[1], 10)
        newLine = parseInt(match[2], 10)
        result.push({ type: 'hunk', content: line })
      }
      continue
    }
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      result.push({ type: 'header', content: line })
      continue
    }
    if (line.startsWith('+')) {
      result.push({ type: 'add', content: line.slice(1), newLine: newLine++ })
      continue
    }
    if (line.startsWith('-')) {
      result.push({ type: 'del', content: line.slice(1), oldLine: oldLine++ })
      continue
    }
    result.push({ type: 'context', content: line.slice(1) || '', oldLine: oldLine++, newLine: newLine++ })
  }
  return result
}

export function DiffViewer({ hostId, repoPath, filePath, staged, commit, workingTree, untracked, label }: { hostId: string; repoPath: string; filePath: string; staged?: boolean; commit?: string; workingTree?: boolean; untracked?: boolean; label?: string }) {
  const { t } = useTranslation()
  const { data, isLoading } = useGitDiff(hostId, repoPath, { filePath: filePath || undefined, staged, commit, workingTree, untracked })
  const lines = useMemo(() => data?.raw ? parseDiff(data.raw) : [], [data?.raw])

  if (isLoading) return <div className="flex h-full items-center justify-center text-sm text-text-3">{t('git.detecting')}</div>
  if (!data?.raw) return <div className="flex h-full items-center justify-center text-sm text-text-3">{t('git.diffEmpty')}</div>

  return (
    <div className="h-full overflow-auto bg-bg-0 font-mono text-[12px] leading-[1.6]">
      <div className="sticky top-0 z-10 border-b border-[var(--line)] bg-bg-1 px-4 py-2">
        <span className="text-sm text-text-1">{t('git.diffTitle', { file: label || filePath || commit || '' })}</span>
        {staged && <span className="ml-2 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] text-accent">staged</span>}
      </div>
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, i) => {
            if (line.type === 'header') {
              return <tr key={i}><td colSpan={3} className="bg-bg-2 px-4 py-0.5 text-[11px] text-text-3">{line.content}</td></tr>
            }
            if (line.type === 'hunk') {
              return <tr key={i}><td colSpan={3} className="bg-accent/5 px-4 py-0.5 text-[11px] text-accent">{line.content}</td></tr>
            }
            const bg = line.type === 'add' ? 'bg-[#1a3a1a]' : line.type === 'del' ? 'bg-[#3a1a1a]' : ''
            const text = line.type === 'add' ? 'text-green-300' : line.type === 'del' ? 'text-red-300' : 'text-text-2'
            const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '
            return (
              <tr key={i} className={bg}>
                <td className="w-[4ch] select-none px-2 text-right text-text-3/50">{line.oldLine ?? ''}</td>
                <td className="w-[4ch] select-none px-2 text-right text-text-3/50">{line.newLine ?? ''}</td>
                <td className={`whitespace-pre px-2 ${text}`}><span className="mr-1 select-none text-text-3/40">{prefix}</span>{line.content}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
