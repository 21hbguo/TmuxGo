import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      react: fileURLToPath(new URL('../../node_modules/.pnpm/react@18.3.1/node_modules/react', import.meta.url)),
      'react-dom': fileURLToPath(new URL('../../node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom', import.meta.url)),
    },
  },
  server: {
    deps: {
      inline: ['react', 'react-dom'],
    },
  },
  test: {
    css: { include: [/globals\.css/] },
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
