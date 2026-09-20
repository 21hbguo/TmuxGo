import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// ssh config 列表条目：只收录可列出的 Host 别名（跳过 *?! 通配/取反 pattern 与 Match 块），
// 连接语义（Include、Host *、ProxyCommand 等）由 `ssh <alias>` 原生生效，这里不做二次翻译。
export interface SshConfigHost {
  alias: string
  hostName: string
  user: string
  port: number | null
  identityFile: string
  proxyJump: string
  forwardAgent: string
  sourceFile: string
  line: number
}

const MAX_INCLUDE_DEPTH = 8
const MAX_INCLUDE_FILES = 64
const BLOCK_FIELD_KEYS: Record<string, keyof SshConfigHost | undefined> = {
  hostname: 'hostName',
  user: 'user',
  port: 'port',
  identityfile: 'identityFile',
  proxyjump: 'proxyJump',
  forwardagent: 'forwardAgent',
}

function isListableAlias(value: string) {
  return /^[A-Za-z0-9._-]{1,64}$/.test(value) && value !== 'local'
}

function expandHome(value: string) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return value
}

// 兼容 `key value`、`key=value`、`key = value` 与单双引号包裹值；`#` 仅在行首(含前导空白)算注释。
function parseConfigLine(line: string) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  const match = trimmed.match(/^([^\s=]+)\s*(?:=\s*|\s+)(.*)$/)
  if (!match) {
    // `Host foo` 等无空格写法不合法，但 `Keyword` 单独成行也直接忽略
    const single = trimmed.match(/^([^\s=]+)\s*$/)
    return single ? { key: single[1].toLowerCase(), value: '' } : null
  }
  let value = match[2].trim()
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  )
    value = value.slice(1, -1)
  return { key: match[1].toLowerCase(), value }
}

function globToRegex(pattern: string) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
  return new RegExp(`^${escaped}$`)
}

async function resolveIncludePaths(patterns: string, fromFile: string) {
  const results: string[] = []
  for (const raw of patterns.split(/\s+/).filter(Boolean)) {
    const expanded = expandHome(raw)
    const absolute = path.isAbsolute(expanded) ? expanded : path.join(path.dirname(fromFile), expanded)
    if (!/[*?]/.test(absolute)) {
      results.push(absolute)
      continue
    }
    try {
      const entries = await fs.readdir(path.dirname(absolute))
      const matcher = globToRegex(path.basename(absolute))
      for (const entry of entries.sort())
        if (matcher.test(entry)) results.push(path.join(path.dirname(absolute), entry))
    } catch {
      // Include 目录不存在时跳过（与 ssh 对缺失 Include 的容错一致）
    }
  }
  return results
}

interface ParsedBlock {
  alias: string
  sourceFile: string
  line: number
  values: Map<string, string>
}

// 按 ssh 语义解析：同参数 first value wins（同一别名出现在多个 Host 块时逐块取首个值）。
async function collectBlocks(
  filePath: string,
  blocks: ParsedBlock[],
  visited: Set<string>,
  filesSeen: { count: number },
  depth: number,
) {
  if (depth > MAX_INCLUDE_DEPTH || filesSeen.count >= MAX_INCLUDE_FILES) return
  const absolute = path.resolve(filePath)
  if (visited.has(absolute)) return
  visited.add(absolute)
  filesSeen.count++
  let content: string
  try {
    content = await fs.readFile(absolute, 'utf8')
  } catch {
    return
  }
  const lines = content.split(/\r?\n/)
  let activeBlocks: ParsedBlock[] = []
  let inMatch = false
  for (let index = 0; index < lines.length; index++) {
    const parsed = parseConfigLine(lines[index])
    if (!parsed) continue
    if (parsed.key === 'match') {
      activeBlocks = []
      inMatch = true
      continue
    }
    if (parsed.key === 'host') {
      inMatch = false
      const aliases = parsed.value
        .split(/\s+/)
        .filter((item) => item && !item.startsWith('!') && !/[*?!]/.test(item) && isListableAlias(item))
      activeBlocks = aliases.map((alias) => {
        const block: ParsedBlock = { alias, sourceFile: absolute, line: index + 1, values: new Map() }
        blocks.push(block)
        return block
      })
      continue
    }
    if (parsed.key === 'include') {
      // Include 允许出现在 Host 块内（视为全局指令），此处统一跟随
      const targets = await resolveIncludePaths(parsed.value, absolute)
      for (const target of targets) await collectBlocks(target, blocks, visited, filesSeen, depth + 1)
      continue
    }
    if (inMatch || !activeBlocks.length) continue
    for (const block of activeBlocks) if (!block.values.has(parsed.key)) block.values.set(parsed.key, parsed.value)
  }
}

export async function resolveSshConfigPath() {
  const fromEnv = process.env.TMUXGO_SSH_CONFIG?.trim()
  if (fromEnv) return expandHome(fromEnv)
  // 对齐 VSCode Remote-SSH：优先读其 remote.SSH.configFile 设置
  try {
    const settings = JSON.parse(await fs.readFile(path.join(os.homedir(), '.config/Code/User/settings.json'), 'utf8'))
    const configured =
      typeof settings?.['remote.SSH.configFile'] === 'string' ? settings['remote.SSH.configFile'].trim() : ''
    if (configured) return expandHome(configured)
  } catch {
    // settings.json 缺失/损坏时回落默认路径
  }
  return path.join(os.homedir(), '.ssh', 'config')
}

export async function listSshConfigHosts(configPath?: string) {
  const root = configPath || (await resolveSshConfigPath())
  const blocks: ParsedBlock[] = []
  await collectBlocks(root, blocks, new Set(), { count: 0 }, 0)
  const merged = new Map<string, SshConfigHost>()
  for (const block of blocks) {
    const existing = merged.get(block.alias)
    if (existing) {
      // first value wins：把后出现的块里尚未见过的关键字补进首个条目
      for (const [key, value] of block.values) {
        const field = BLOCK_FIELD_KEYS[key]
        if (field && !existing[field]) {
          if (field === 'port') {
            const port = Number(value)
            if (Number.isInteger(port) && port > 0 && port <= 65535) existing.port = port
          } else (existing[field] as string) = value
        }
      }
      continue
    }
    const port = Number(block.values.get('port'))
    merged.set(block.alias, {
      alias: block.alias,
      hostName: block.values.get('hostname') || '',
      user: block.values.get('user') || '',
      port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : null,
      identityFile: block.values.get('identityfile') || '',
      proxyJump: block.values.get('proxyjump') || '',
      forwardAgent: block.values.get('forwardagent') || '',
      sourceFile: block.sourceFile,
      line: block.line,
    })
  }
  return [...merged.values()]
}

export async function readSshConfigText(configPath?: string) {
  const filePath = configPath || (await resolveSshConfigPath())
  try {
    return { path: filePath, content: await fs.readFile(filePath, 'utf8') }
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { path: filePath, content: '' }
    throw err
  }
}

async function writeConfigFile(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  try {
    await fs.copyFile(filePath, `${filePath}.bak`)
  } catch {
    // 首次写入无旧文件可备份
  }
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(temporary, content.endsWith('\n') ? content : `${content}\n`, { encoding: 'utf8', mode: 0o600 })
  await fs.chmod(temporary, 0o600)
  await fs.rename(temporary, filePath)
  await fs.chmod(filePath, 0o600)
}

// PUT 只写已解析出的 config 路径，路径永不来自请求体，防任意文件写。
export async function writeSshConfigText(content: string) {
  const filePath = await resolveSshConfigPath()
  await writeConfigFile(filePath, content)
  return { path: filePath }
}

export interface SshConfigHostInput {
  alias: string
  hostName: string
  user?: string
  port?: number
  identityFile?: string
}

function sanitizeConfigField(value: string | undefined, field: string, required = false) {
  const trimmed = (value || '').trim()
  if (required && !trimmed) throw new Error(`Missing ${field}`)
  if (/[\s\x00-\x1f]/.test(trimmed) || trimmed.includes('#')) throw new Error(`Invalid ${field}`)
  return trimmed
}

export async function appendSshConfigHost(input: SshConfigHostInput) {
  const alias = sanitizeConfigField(input.alias, 'alias', true)
  if (!isListableAlias(alias)) throw new Error('Invalid host alias')
  const hostName = sanitizeConfigField(input.hostName, 'hostName', true)
  const user = sanitizeConfigField(input.user, 'user')
  const identityFile = sanitizeConfigField(input.identityFile, 'identityFile')
  const port = input.port === undefined ? null : input.port
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Invalid port')
  const filePath = await resolveSshConfigPath()
  const existing = await listSshConfigHosts(filePath)
  if (existing.some((entry) => entry.alias === alias)) throw new Error(`Host alias "${alias}" already exists`)
  const { content } = await readSshConfigText(filePath)
  const block = [
    `Host ${alias}`,
    `  HostName ${hostName}`,
    ...(user ? [`  User ${user}`] : []),
    ...(port ? [`  Port ${port}`] : []),
    ...(identityFile ? [`  IdentityFile ${identityFile}`] : []),
  ].join('\n')
  await writeConfigFile(filePath, `${content.trimEnd()}\n\n${block}\n`)
  return { path: filePath, alias }
}

// `ssh -G` 不发起连接，毫秒级返回 effective 值；只在详情/resolve 端点按需调用。
export async function resolveSshHostEffective(alias: string) {
  if (!isListableAlias(alias)) throw new Error('Invalid host alias')
  const { stdout } = await execFileAsync('ssh', ['-G', alias], { timeout: 5000, maxBuffer: 1024 * 1024 })
  const values = new Map<string, string>()
  const identityFiles: string[] = []
  for (const line of stdout.split('\n')) {
    const space = line.indexOf(' ')
    if (space <= 0) continue
    const key = line.slice(0, space).toLowerCase()
    const value = line.slice(space + 1).trim()
    if (key === 'identityfile') identityFiles.push(value)
    else if (!values.has(key)) values.set(key, value)
  }
  return {
    hostname: values.get('hostname') || '',
    user: values.get('user') || '',
    port: Number(values.get('port')) || 22,
    identityFiles,
    proxyJump: values.get('proxyjump') || '',
    forwardAgent: values.get('forwardagent') || '',
    strictHostKeyChecking: values.get('stricthostkeychecking') || '',
  }
}
