import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const baselineFile = join(root, 'scripts', 'eslint-warning-baseline.txt')
const baseline = parseInt(readFileSync(baselineFile, 'utf8').trim(), 10)
if (!Number.isFinite(baseline)) throw new Error(`Invalid ESLint warning baseline in ${baselineFile}`)

const eslintBin = join(root, 'node_modules', '.bin', 'eslint')
if (!existsSync(eslintBin)) throw new Error('eslint binary not found; run pnpm install first')

// errors 出现时 eslint 退出码非 0，但 stdout 仍带完整 JSON，照常解析统计
let output: string
try {
  output = execFileSync(eslintBin, ['.', '--format', 'json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
} catch (error: any) {
  output = error?.stdout || ''
  if (!output) throw error
}
const results = JSON.parse(output) as {
  warningCount: number
  errorCount: number
  messages: { severity: number; ruleId: string | null }[]
}[]

let warnings = 0
let errors = 0
const byRule = new Map<string, number>()
for (const file of results) {
  warnings += file.warningCount
  errors += file.errorCount
  for (const message of file.messages) {
    if (message.severity !== 1) continue
    const rule = message.ruleId || 'unknown'
    byRule.set(rule, (byRule.get(rule) || 0) + 1)
  }
}

console.log(`ESLint warnings: ${warnings} (baseline ${baseline}), errors: ${errors}`)
for (const [rule, count] of [...byRule.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${count.toString().padStart(4)}  ${rule}`)
}
if (warnings > baseline) {
  console.error(
    `ESLint warnings increased by ${warnings - baseline} over baseline; fix new warnings or lower them before merging`,
  )
  process.exit(1)
}
if (errors > 0) {
  console.error('ESLint errors present')
  process.exit(1)
}
console.log('ESLint warning baseline check passed')
