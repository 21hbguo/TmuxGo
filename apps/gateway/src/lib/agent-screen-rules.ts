import { readdirSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getVisibleTerminalLines } from './terminal-output.js'

// 借鉴 herdr 的 per-agent detection manifest：每家一份按 priority 降序的规则，
// 只看 pane 底部可见区域（live bottom），命中即定状态；比全局正则精度高且可逐家补充。
// 词面来源：herdr distribution/agent-detection/*.toml（kimi/devin/opencode）。
export type ScreenRuleState = 'idle' | 'working' | 'blocked'
interface RawClause {
  contains?: string[]
  any?: RawClause[]
  all?: RawClause[]
  not?: RawClause[]
  line_regex?: string[]
  regex?: string[]
}
interface RawRule extends RawClause {
  id: string
  state: ScreenRuleState
  // blocked 的细分相位：审批→permission_required，提问→needs_input
  phase?: 'permission_required' | 'needs_input'
  priority: number
  // whole_recent=标题+可见末尾16行；bottom_N=末尾N个非空行；title=仅标题
  region?: 'whole_recent' | 'title' | `bottom_non_empty_lines(${number})`
}
interface Clause {
  contains?: string[]
  any?: Clause[]
  all?: Clause[]
  not?: Clause[]
  lineRegex?: RegExp[]
  regex?: RegExp[]
}
export interface ScreenRule extends Clause {
  id: string
  state: ScreenRuleState
  phase?: 'permission_required' | 'needs_input'
  priority: number
  region?: string
}

const rawManifests: Record<string, RawRule[]> = {
  kimi: [
    {
      id: 'current_approval_panel',
      state: 'blocked',
      priority: 400,
      region: 'whole_recent',
      contains: ['↵ confirm'],
      any: [
        { contains: ['run this command?'] },
        { contains: ['write this file?'] },
        { contains: ['apply these edits?'] },
        { contains: ['stop this task?'] },
        { contains: ['ready to build with this plan?'] },
        { line_regex: ['(?i)^\\s*▶?\\s*approve .*\\?$'] },
      ],
      all: [
        { contains: [' choose'] },
        { any: [{ contains: ['approve'] }, { contains: ['reject'] }, { contains: ['revise'] }] },
      ],
    },
    {
      id: 'question_panel',
      state: 'blocked',
      phase: 'needs_input',
      priority: 390,
      region: 'whole_recent',
      contains: ['↑↓ select', 'esc cancel'],
      line_regex: ['^\\s*question\\s*$', '^\\s*\\? '],
      any: [{ contains: ['↵ choose'] }, { contains: ['↵ toggle'] }, { contains: ['↵ save'] }],
    },
    {
      id: 'legacy_approval_panel',
      state: 'blocked',
      priority: 300,
      region: 'whole_recent',
      contains: ['requesting approval', 'reject'],
      any: [{ contains: ['approve once'] }, { contains: ['approve for this session'] }],
      all: [{ any: [{ contains: ['1/2/3/4 choose'] }, { contains: ['↵ confirm'] }] }],
    },
    {
      id: 'background_agent_status_working',
      state: 'working',
      priority: 120,
      region: 'bottom_non_empty_lines(3)',
      line_regex: ['(?i)\\bkimi[-\\w.]*\\s+thinking\\b.*\\[[1-9][0-9]*\\s+agents?\\s+running\\]'],
    },
    {
      // kimi 用月相字符做 spinner，不在通用 braille 范围内
      id: 'moon_spinner_working',
      state: 'working',
      priority: 100,
      region: 'whole_recent',
      line_regex: ['^\\s*(🌕|🌖|🌗|🌘|🌑|🌒|🌓|🌔)\\s*$'],
    },
    {
      id: 'braille_spinner_working',
      state: 'working',
      priority: 90,
      region: 'whole_recent',
      line_regex: ['(?i)^\\s*[⠀-⣿]+\\s*(thinking\\.\\.\\.|working\\.\\.\\.|using )'],
    },
  ],
  devin: [
    {
      id: 'workspace_trust_prompt',
      state: 'blocked',
      priority: 300,
      region: 'bottom_non_empty_lines(8)',
      contains: ['do you trust the authors of this directory?', 'with untrusted content.', 'yes, trust '],
    },
    {
      id: 'permission_prompt',
      state: 'blocked',
      priority: 290,
      region: 'bottom_non_empty_lines(8)',
      contains: ['approve once', 'select', 'confirm', 'esc cancel'],
    },
    {
      id: 'running_tools_footer',
      state: 'working',
      priority: 200,
      region: 'bottom_non_empty_lines(8)',
      contains: ['running tools', 'esc to interrupt'],
      not: [{ contains: ['approve once', 'esc cancel'] }],
    },
    {
      id: 'guide_while_working',
      state: 'working',
      priority: 190,
      region: 'bottom_non_empty_lines(6)',
      contains: ['guide devin while it works'],
      not: [{ contains: ['approve once', 'esc cancel'] }],
    },
    {
      id: 'tool_reading_timeout',
      state: 'working',
      priority: 180,
      region: 'bottom_non_empty_lines(8)',
      contains: ['reading shell ', 'timeout:'],
      not: [{ contains: ['approve once', 'esc cancel'] }],
    },
    {
      id: 'welcome_prompt_footer',
      state: 'idle',
      priority: 120,
      region: 'bottom_non_empty_lines(8)',
      contains: ['ask devin to build', 'features, fix bugs', 'your code'],
      line_regex: ['^\\s*❭ Ask Devin to build'],
      not: [
        { contains: ['approve once', 'esc cancel'] },
        { contains: ['running tools', 'esc to interrupt'] },
        { contains: ['guide devin while it works'] },
      ],
    },
    {
      id: 'live_prompt_footer',
      state: 'idle',
      priority: 100,
      region: 'bottom_non_empty_lines(6)',
      contains: ['context:'],
      line_regex: ['^\\s*❭'],
      not: [
        { contains: ['approve once', 'esc cancel'] },
        { contains: ['running tools', 'esc to interrupt'] },
        { contains: ['guide devin while it works'] },
      ],
    },
  ],
  opencode: [
    {
      id: 'permission_required',
      state: 'blocked',
      priority: 300,
      region: 'whole_recent',
      any: [
        { contains: ['△ Permission required'] },
        {
          contains: ['esc dismiss'],
          any: [{ contains: ['enter confirm'] }, { contains: ['enter submit'] }, { contains: ['enter toggle'] }],
          all: [{ any: [{ contains: ['↑↓ select'] }, { contains: ['⇆ tab'] }] }],
        },
      ],
    },
    {
      id: 'interrupt_hint_working',
      state: 'working',
      priority: 110,
      region: 'whole_recent',
      any: [
        { contains: ['esc to interrupt'] },
        { contains: ['ctrl+c to interrupt'] },
        { contains: ['press esc to interrupt'] },
        { line_regex: ['(?i).*opencode.*esc (again to )?interrupt'] },
      ],
    },
    {
      id: 'progress_bar_working',
      state: 'working',
      priority: 100,
      region: 'whole_recent',
      regex: ['(■|⬝){4,}'],
    },
  ],
}
// mimo(MiMo Code) 是 opencode 同源 TUI，先共用其词面规则
const ruleAliases: Record<string, string> = { mimo: 'opencode' }

// herdr 词面沿用 Rust 的 (?i) 行内旗标写法，JS 需拆成 RegExp flag
function compilePattern(pattern: string) {
  const flagMatch = pattern.match(/^\(\?([imsu]+)\)/)
  return flagMatch ? new RegExp(pattern.slice(flagMatch[0].length), flagMatch[1]) : new RegExp(pattern)
}
function compileClause(raw: RawClause): Clause {
  return {
    contains: raw.contains,
    any: raw.any?.map(compileClause),
    all: raw.all?.map(compileClause),
    not: raw.not?.map(compileClause),
    lineRegex: raw.line_regex?.map(compilePattern),
    regex: raw.regex?.map(compilePattern),
  }
}
const manifests: Record<string, ScreenRule[]> = Object.fromEntries(
  Object.entries(rawManifests).map(([agent, rules]) => [
    agent,
    rules
      .map((rule) => ({
        ...compileClause(rule),
        id: rule.id,
        state: rule.state,
        phase: rule.phase,
        priority: rule.priority,
        region: rule.region,
      }))
      .sort((a, b) => b.priority - a.priority),
  ]),
)

function clauseMatches(clause: Clause, text: string, lines: string[]): boolean {
  if (clause.contains && !clause.contains.every((item) => text.includes(item))) return false
  if (clause.lineRegex && !clause.lineRegex.some((pattern) => lines.some((line) => pattern.test(line)))) return false
  if (clause.regex && !clause.regex.some((pattern) => pattern.test(text))) return false
  if (clause.any && !clause.any.some((item) => clauseMatches(item, text, lines))) return false
  if (clause.all && !clause.all.every((item) => clauseMatches(item, text, lines))) return false
  if (clause.not && clause.not.some((item) => clauseMatches(item, text, lines))) return false
  return true
}
function resolveRegion(region: string | undefined, title: string, visible: string[], nonEmpty: string[]) {
  if (region === 'title') return { text: title, lines: [title] }
  const bottom = region?.match(/^bottom_non_empty_lines\((\d+)\)$/)
  if (bottom) {
    const lines = nonEmpty.slice(-Number(bottom[1]))
    return { text: lines.join('\n'), lines }
  }
  // whole_recent：标题+可见末尾16行（与通用判定同一视野）
  const lines = [title, ...visible.slice(-16)]
  return { text: lines.join('\n'), lines }
}
// --- 本地 TOML override（herdr 语义：~/.tmuxgo/agent-detection/<agent>.toml 整体覆盖 bundled）---
// 只支持 manifest 用得到的 TOML 子集：key=value、[[rules]]、字符串/数字/布尔、
// 数组、内联表；value 解析器自带终止，空白/换行统一视作分隔符
function tomlStripComments(src: string) {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quote === '"' && c === '\\') {
      out += c + (src[++i] ?? '')
      continue
    }
    if (quote) {
      if (c === quote) quote = null
      out += c
    } else if (c === '"' || c === "'") {
      quote = c
      out += c
    } else if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++
    } else out += c
  }
  return out
}
function parseTomlSubset(src: string): Record<string, unknown> {
  const text = tomlStripComments(src)
  let i = 0
  const root: Record<string, unknown> = {}
  let table: Record<string, unknown> = root
  const skip = () => {
    while (i < text.length && /\s/.test(text[i])) i++
  }
  const bare = () => {
    const start = i
    while (i < text.length && !/[\s=\],{}#]/.test(text[i])) i++
    return text.slice(start, i)
  }
  const parseValue = (): unknown => {
    skip()
    const c = text[i]
    if (c === '"' || c === "'") {
      const quote = c
      i++
      let value = ''
      while (i < text.length && text[i] !== quote) {
        if (quote === '"' && text[i] === '\\') {
          i++
          const esc = text[i++]
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc
        } else value += text[i++]
      }
      i++
      return value
    }
    if (c === '[') {
      i++
      const arr: unknown[] = []
      for (;;) {
        skip()
        if (text[i] === ']') {
          i++
          return arr
        }
        if (i >= text.length) return arr
        arr.push(parseValue())
        skip()
        if (text[i] === ',') i++
      }
    }
    if (c === '{') {
      i++
      const obj: Record<string, unknown> = {}
      for (;;) {
        skip()
        if (text[i] === '}') {
          i++
          return obj
        }
        if (i >= text.length) return obj
        const key = bare()
        skip()
        i++ // '='
        obj[key] = parseValue()
        skip()
        if (text[i] === ',') i++
      }
    }
    const token = bare()
    if (token === 'true') return true
    if (token === 'false') return false
    const num = Number(token)
    return Number.isNaN(num) ? token : num
  }
  while (true) {
    skip()
    if (i >= text.length) return root
    if (text.startsWith('[[', i)) {
      i += 2
      const name = bare()
      i += text.startsWith(']]', i) ? 2 : 0
      const arr = (root[name] ??= []) as unknown[]
      table = {}
      arr.push(table)
      continue
    }
    if (text[i] === '[') {
      i++
      const name = bare()
      i++
      table = (root[name] ??= {}) as Record<string, unknown>
      continue
    }
    const key = bare()
    if (!key) {
      // 容错前进：遇到无法识别的裸字符（如坏文件的 `]`）必须推进 i，否则死循环
      i++
      continue
    }
    skip()
    if (text[i] === '=') {
      i++
      table[key] = parseValue()
    }
  }
}
// 每次调用按 mtime 校验文件：扫一轮本来就有磁盘 IO，stat 开销可忽略且行为确定
const overrideFileCache = new Map<string, { mtimeMs: number; rules: ScreenRule[] }>()
function agentDetectionDir() {
  return path.join(process.env.TMUXGO_CONFIG_DIR?.trim() || path.join(os.homedir(), '.tmuxgo'), 'agent-detection')
}
function compileOverrideFile(filePath: string, mtimeMs: number): ScreenRule[] {
  const cached = overrideFileCache.get(filePath)
  if (cached && cached.mtimeMs === mtimeMs) return cached.rules
  const doc = parseTomlSubset(readFileSync(filePath, 'utf8'))
  const rules = (Array.isArray(doc.rules) ? (doc.rules as RawRule[]) : [])
    .filter((rule) => rule && typeof rule.id === 'string' && typeof rule.priority === 'number')
    .map((rule) => ({
      ...compileClause(rule),
      id: rule.id,
      state: rule.state,
      phase: rule.phase,
      priority: rule.priority,
      region: rule.region,
    }))
    .sort((a, b) => b.priority - a.priority)
  overrideFileCache.set(filePath, { mtimeMs, rules })
  return rules
}
function overrideManifests() {
  const next = new Map<string, ScreenRule[]>()
  let files: string[]
  try {
    files = readdirSync(agentDetectionDir()).filter((file) => file.endsWith('.toml'))
  } catch {
    return next
  }
  for (const file of files) {
    const filePath = path.join(agentDetectionDir(), file)
    try {
      const rules = compileOverrideFile(filePath, statSync(filePath).mtimeMs)
      if (rules.length) next.set(path.basename(file, '.toml'), rules)
    } catch {
      // 坏文件跳过该 agent 的 override，回落 bundled manifest
    }
  }
  return next
}
export function matchAgentScreenRule(agent: string, title: string, output: string): ScreenRule | null {
  const id = ruleAliases[agent] ?? agent
  const overrides = overrideManifests()
  // 查找序：本名 override > 别名 override > 本名 bundled > 别名 bundled
  const rules = overrides.get(agent) ?? overrides.get(id) ?? manifests[agent] ?? manifests[id]
  if (!rules) return null
  const visible = getVisibleTerminalLines(output)
  const nonEmpty = visible.filter((line) => line.trim())
  for (const rule of rules) {
    const { text, lines } = resolveRegion(rule.region, title, visible, nonEmpty)
    if (clauseMatches(rule, text, lines)) return rule
  }
  return null
}
