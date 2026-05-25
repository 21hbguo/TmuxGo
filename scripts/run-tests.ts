import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

function collectTests(dir: string, acc: string[] = []) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    const stats = statSync(fullPath)
    if (stats.isDirectory()) {
      collectTests(fullPath, acc)
      continue
    }
    if (/\.(test|spec)\.tsx?$/.test(entry)) {
      acc.push(fullPath)
    }
  }
  return acc
}

const files = collectTests(join(process.cwd(), 'tests'))
if (files.length === 0) {
  console.error('No test files found')
  process.exit(1)
}

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { stdio: 'inherit' })
process.exit(result.status ?? 1)
