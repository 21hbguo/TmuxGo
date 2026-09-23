import { defineConfig } from '@playwright/test'

const externalServer = process.env.TMUXGO_E2E_URL || process.env.TMUXGO_PLUGIN_E2E_URL

export default defineConfig({
  testDir: './e2e',
  testIgnore: [
    ...(process.env.TMUXGO_AUTH_E2E_URL ? [] : ['**/auth*.spec.ts', '**/default-password.spec.ts']),
    // 测量 spec 只在 pnpm measure:perf（TMUXGO_MEASURE_PERF=1）时进入套件，不进默认 e2e 扫描
    ...(process.env.TMUXGO_MEASURE_PERF ? [] : ['**/measure-*.spec.ts']),
  ],
  timeout: 30000,
  workers: process.env.TMUXGO_E2E_WORKERS ? Number(process.env.TMUXGO_E2E_WORKERS) : undefined,
  use: {
    baseURL: externalServer || 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
  },
  webServer: externalServer
    ? undefined
    : {
        command: './start.sh',
        url: 'http://127.0.0.1:3000',
        reuseExistingServer: true,
        timeout: 180000,
      },
})
