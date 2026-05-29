import fs from 'fs'
import path from 'path'

const root = process.cwd()
const targets = [
  'apps/frontend/src/hooks/useTerminalOutputScheduler.ts',
  'apps/gateway/src/lib/perf-metrics.ts',
  'apps/gateway/src/routes/stream.ts',
  'apps/frontend/src/components/StatusBar.tsx',
]
const fileChecks: Record<string, string[]> = {
  'apps/frontend/src/hooks/useTerminalOutputScheduler.ts': ['onBackpressure', 'BACKPRESSURE_HIGH_WATERMARK'],
  'apps/gateway/src/lib/perf-metrics.ts': ['backpressureSignals', 'activeFlushInterval', 'activeMaxChars'],
  'apps/gateway/src/routes/stream.ts': ['stream_backpressure', 'stream_profile', 'syncOutputProfile'],
  'apps/frontend/src/components/StatusBar.tsx': ['activeFlushInterval', 'backpressureSignals'],
}
let failed = false
for (const rel of targets) {
  const full = path.join(root, rel)
  if (!fs.existsSync(full)) {
    console.error(`missing:${rel}`)
    failed = true
    continue
  }
  const content = fs.readFileSync(full, 'utf8')
  for (const snippet of fileChecks[rel] || []) {
    if (content.includes(snippet)) continue
    console.error(`missing-snippet:${rel}:${snippet}`)
    failed = true
  }
}
if (failed) process.exit(1)
console.log('fluency-metrics-verify:ok')
