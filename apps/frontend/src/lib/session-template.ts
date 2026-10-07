import type { Session, SessionTemplate } from '@/types'

export function getTemplateSessionName(template: SessionTemplate) {
  return (
    template.name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'session'
  )
}

function escapeRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 默认名 = {base}-{最小未用序号}：base 取 workspace 名（无 workspace 用 session），
// default 模板不挂 slug（避免名字里出现无意义的 default）；序号补洞而非 max+1，
// 与 tmux window 编号习惯一致，删除会话后序号回收紧凑
export function getDefaultSessionName(
  template: SessionTemplate,
  sessions: Pick<Session, 'name'>[],
  workspaceName?: string,
) {
  const slug = getTemplateSessionName(template)
  const base = `${workspaceName?.trim() || 'session'}${slug === 'default' ? '' : `-${slug}`}`
  const pattern = new RegExp(`^${escapeRegExp(base)}-(\\d+)$`)
  const used = new Set<number>()
  for (const session of sessions) {
    const match = pattern.exec(session.name)
    if (match) used.add(Number(match[1]))
  }
  let index = 1
  while (used.has(index)) index += 1
  return `${base}-${index}`
}
