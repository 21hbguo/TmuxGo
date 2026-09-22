// RFC4180 简版解析：支持双引号字段、"" 转义、字段内换行与 CRLF
export function parseCsv(content: string): string[][] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += ch
      continue
    }
    if (ch === '"' && field === '') {
      inQuotes = true
      continue
    }
    if (ch === ',') {
      pushField()
      continue
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && content[i + 1] === '\n') i++
      pushRow()
      continue
    }
    field += ch
  }
  pushRow()
  // 末尾换行会多出一个空行；空文件等价于无数据
  while (rows.length && rows[rows.length - 1].every((cell) => cell === '')) rows.pop()
  return rows
}
