#!/usr/bin/env node
// 纯 mjs 包（apps/cli、apps/mcp）的入口契约校验：
// bin 指向必须存在、带 node shebang，包内全部 mjs 过 node --check 语法检查。
// files 里 vendor 由 prepack 生成，干净 clone 上不存在，故不校验 files 字段。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkgDirs = ['apps/cli', 'apps/mcp']
const skipDirs = new Set(['node_modules', 'vendor', 'dist'])
const errors = []
const mjsFiles = []

function collect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) collect(path)
    } else if (entry.name.endsWith('.mjs')) {
      mjsFiles.push(path)
    }
  }
}

for (const rel of pkgDirs) {
  const dir = join(root, rel)
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin || {})
  for (const bin of bins) {
    const file = join(dir, bin)
    if (!existsSync(file)) {
      errors.push(`${rel}: bin entry "${bin}" does not exist`)
      continue
    }
    if (!readFileSync(file, 'utf8').startsWith('#!/usr/bin/env node')) {
      errors.push(`${rel}: bin entry "${bin}" is missing the node shebang`)
    }
  }
  collect(dir)
}

for (const file of mjsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    errors.push(`${file} failed node --check: ${error.message}`)
  }
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}
console.log(`entrypoints OK: ${mjsFiles.length} mjs files checked`)
