import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// e2e 失败产物上传前脱敏：Playwright trace/screenshot/report 可能含 token、
// 密码或完整终端输出中的敏感串。替换两类内容：
//   1. 运行时注入的 secret env 值（TMUXGO_*_TOKEN/PASSWORD/KEY 等，见 SECRET_ENV_RE）
//   2. 常见凭据形态（Bearer、x-tmuxgo-agent-token、Authorization）
// .zip trace 是二进制归档不逐字节改写；其中敏感串主要靠 env 值替换覆盖不到的
// 场景已在上游隔离（e2e 凭据全为一次性测试值），见 docs/ci.md。
const SECRET_ENV_RE = /(TOKEN|PASSWORD|SECRET|PRIVATE_KEY|PASSPHRASE|CREDENTIAL)/i
const MIN_SECRET_LEN = 6 // 过短的 env 值（如 "1"/"admin"）不脱敏，避免误伤正文
const GENERIC_PATTERNS: [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer ***'],
  [/x-tmuxgo-agent-token["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi, 'x-tmuxgo-agent-token: ***'],
  [/authorization["']?\s*[:=]\s*["']?[^\s"',}]{8,}/gi, 'authorization: ***'],
]
const TEXT_EXT = new Set(['.txt', '.json', '.html', '.htm', '.md', '.log', '.stderr', '.stdout', '.xml'])

export function collectSecrets(env: NodeJS.ProcessEnv = process.env) {
  const secrets = new Set<string>()
  for (const [key, value] of Object.entries(env)) {
    if (!value || !SECRET_ENV_RE.test(key)) continue
    if (value.length >= MIN_SECRET_LEN) secrets.add(value)
  }
  return secrets
}

export function scrubText(text: string, secrets: ReadonlySet<string>) {
  let output = text
  for (const secret of secrets) if (secret) output = output.split(secret).join('***')
  for (const [pattern, replacement] of GENERIC_PATTERNS) output = output.replace(pattern, replacement)
  return output
}

async function scrubDir(dir: string, secrets: ReadonlySet<string>, stats: { files: number; redacted: number }) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // 目录不存在不算错误（可能本次没有产出）
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await scrubDir(full, secrets, stats)
      continue
    }
    if (!entry.isFile()) continue
    const ext = entry.name.slice(entry.name.lastIndexOf('.'))
    if (!TEXT_EXT.has(ext.toLowerCase())) continue
    const info = await stat(full).catch(() => null)
    if (!info || info.size > 20 * 1024 * 1024) continue // 超大文件跳过（report/trace 主体不含文本凭据）
    const raw = await readFile(full, 'utf8').catch(() => null)
    if (raw === null) continue
    const scrubbed = scrubText(raw, secrets)
    stats.files += 1
    if (scrubbed !== raw) {
      await writeFile(full, scrubbed, 'utf8')
      stats.redacted += 1
    }
  }
}

async function main() {
  const dirs = process.argv.slice(2)
  const targets = dirs.length ? dirs : ['test-results', 'playwright-report']
  const secrets = collectSecrets()
  const stats = { files: 0, redacted: 0 }
  for (const dir of targets) await scrubDir(dir, secrets, stats)
  console.log(`scrub-e2e-artifacts: scanned ${stats.files} text files, redacted ${stats.redacted}`)
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
if (isMain !== false) void main()
