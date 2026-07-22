import { defineConfig } from '@playwright/test'

const externalServer = process.env.TMUXGO_PLUGIN_E2E_URL

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  use: {
    baseURL: externalServer || 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
  },
  webServer: externalServer ? undefined : {
    command: './start.sh',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: true,
    timeout: 180000,
  },
})
