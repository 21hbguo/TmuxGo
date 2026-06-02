import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['./src/**/*.test.{ts,tsx}'],
    globals: true,
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    maxConcurrency: 1,
    execArgv: ['--max-old-space-size=4096'],
    env: {
      NODE_ENV: 'test',
    },
  },
})
