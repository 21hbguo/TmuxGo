import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let directory = dirname(fileURLToPath(import.meta.url))
while (!existsSync(join(directory, 'node_modules'))) {
  const parent = dirname(directory)
  if (parent === directory) process.exit(0)
  directory = parent
}
const pending = [join(directory, 'node_modules')]
while (pending.length) {
  const current = pending.pop()
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const target = join(current, entry.name)
    if (entry.isDirectory()) {
      pending.push(target)
      continue
    }
    if (!entry.isFile() || !(entry.name.endsWith('.node') || entry.name === 'spawn-helper' || entry.name === 'esbuild' || entry.name === 'swc')) continue
    if ((statSync(target).mode & 0o100) === 0) chmodSync(target, 0o755)
  }
}
