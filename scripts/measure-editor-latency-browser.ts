import { assertSupportedNode, bootstrapE2E, resolveBin, run, type E2EEnvironment } from './e2e-env'

// 编辑区延迟验收（真实浏览器）：复用 e2e 隔离环境（临时 dist + 隔离 tmux server 的
// test session + loopback gateway），跑 e2e/editor-latency.spec.ts。
// 用法：npx tsx scripts/measure-editor-latency-browser.ts [--headed]
const root = process.cwd()
let env: E2EEnvironment | undefined
function handleSignal(code: number) {
  void (env?.cleanup() ?? Promise.resolve()).finally(() => process.exit(code))
}
process.once('SIGINT', () => handleSignal(130))
process.once('SIGTERM', () => handleSignal(143))

async function main() {
  assertSupportedNode()
  env = await bootstrapE2E(root)
  const playwrightBin = resolveBin(root, 'playwright')
  try {
    const target = process.env.TMUXGO_EDITOR_E2E_SPEC || 'e2e/editor-latency.spec.ts'
    const args = ['test', target, '--reporter=line']
    if (process.argv.includes('--headed')) args.push('--headed')
    process.exitCode = await run(playwrightBin, args, {
      cwd: root,
      env: { ...env.playwrightEnv, TMUXGO_FRONTEND_DIST: env.frontendDist },
    })
  } finally {
    await env.cleanup()
  }
}

void main().catch(async (error) => {
  console.error(error)
  await env?.cleanup()
  process.exitCode = 1
})
