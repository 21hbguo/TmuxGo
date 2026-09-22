'use client'
import { useMemo } from 'react'
import { parseCsv } from '@/lib/csv'

export function CsvTable({ content, emptyLabel }: { content: string; emptyLabel: string }) {
  const rows = useMemo(() => parseCsv(content), [content])
  if (!rows.length)
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center bg-bg-1/60 text-sm text-text-3">{emptyLabel}</div>
    )
  // 按约定首行当表头；列数取最大行宽并补齐，保证边框对齐
  const cols = Math.max(...rows.map((row) => row.length))
  const [header, ...body] = rows
  return (
    <div className="tmuxgo-scrollbar min-w-0 flex-1 overflow-auto bg-bg-1/60 p-4">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {Array.from({ length: cols }, (_, i) => (
              <th
                key={i}
                className="sticky top-0 border border-[var(--line)] bg-bg-2 px-2 py-1 text-left font-semibold whitespace-pre-wrap break-words text-text-1"
              >
                {header[i] || ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {Array.from({ length: cols }, (_, i) => (
                <td
                  key={i}
                  className="border border-[var(--line)] px-2 py-1 align-top whitespace-pre-wrap break-words text-text-2"
                >
                  {row[i] || ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
