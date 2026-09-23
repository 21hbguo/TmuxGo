import { assertSupportedNode, bootstrapE2E, resolveBin, run, type E2EEnvironment } from './e2e-env'

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
    const result = await run(playwrightBin, ['test', ...process.argv.slice(2)], {
      cwd: root,
      env: env.playwrightEnv,
    })
    process.exitCode = result
  } finally {
    await env.cleanup()
  }
}
void main().catch(async (error) => {
  console.error(error)
  await env?.cleanup()
  process.exitCode = 1
})
