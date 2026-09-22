import { join } from 'node:path'
import { assertSupportedNode, bootstrapE2E, resolveBin, run, type E2EEnvironment } from './e2e-env'

// U5 交互性能验收：复用 e2e 隔离环境（临时 dist + 隔离 tmux server 的 test
// session + gateway），追加 noVNC 独立构建产物，跑 e2e/measure-perf.spec.ts
// 产出任务时间指标与构建预算统计。TMUXGO_MEASURE_ROUNDS 控制轮数（默认 5）
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
  const viteBin = resolveBin(root, 'vite')
  const playwrightBin = resolveBin(root, 'playwright')
  try {
    // noVNC 独立 lib 构建进同一 dist，让预算统计覆盖其产物（对齐 package.json build 顺序）
    if (
      (await run(viteBin, ['build', '--config', 'vite.novnc.config.ts', '--outDir', env.frontendDist], {
        cwd: join(root, 'apps/frontend'),
        env: env.tmuxEnv,
      })) !== 0
    )
      throw new Error('noVNC build failed')
    const result = await run(playwrightBin, ['test', 'e2e/measure-perf.spec.ts'], {
      cwd: root,
      env: { ...env.playwrightEnv, TMUXGO_MEASURE_PERF: '1', TMUXGO_FRONTEND_DIST: env.frontendDist },
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
