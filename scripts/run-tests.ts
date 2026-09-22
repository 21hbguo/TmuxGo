import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

function assertSupportedNode() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (!((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 24)) {
    console.error(`Unsupported Node.js ${process.version}. Need ^20.19 || ^22.12 || >=24 (nvm use with .nvmrc)`)
    process.exit(1)
  }
}

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

assertSupportedNode()

const files = collectTests(join(process.cwd(), 'tests'))
if (files.length === 0) {
  console.error('No test files found')
  process.exit(1)
}

// Isolate unit-test side effects away from the real ~/.tmuxgo config dir.
const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
const previousPreferencesDir = process.env.TMUXGO_PREFERENCES_DIR
const previousTmpDir = process.env.TMUXGO_TMP_DIR
const configDir = mkdtempSync(join(tmpdir(), 'tmuxgo-unit-tests-'))
process.env.TMUXGO_CONFIG_DIR = configDir
process.env.TMUXGO_PREFERENCES_DIR = join(configDir, 'preferences')
process.env.TMUXGO_TMP_DIR = join(configDir, 'tmp')

let status: number
try {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { stdio: 'inherit', env: process.env })
  status = result.status ?? 1
} finally {
  if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
  else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
  if (previousPreferencesDir === undefined) delete process.env.TMUXGO_PREFERENCES_DIR
  else process.env.TMUXGO_PREFERENCES_DIR = previousPreferencesDir
  if (previousTmpDir === undefined) delete process.env.TMUXGO_TMP_DIR
  else process.env.TMUXGO_TMP_DIR = previousTmpDir
  rmSync(configDir, { recursive: true, force: true })
}
process.exit(status)
