import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
  },
  webServer: {
    command: './start.sh',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: true,
    timeout: 180000,
  },
})
