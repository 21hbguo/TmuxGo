import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')) as {
  version: string
}
function getBuildId() {
  if (process.env.VITE_APP_BUILD_ID) return process.env.VITE_APP_BUILD_ID
  try {
    return `${packageJson.version}-${execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()}`
  } catch {
    return packageJson.version
  }
}
const buildId = getBuildId()
export default defineConfig({
  plugins: [
    react(),
    tsconfigPaths(),
    {
      name: 'tmuxgo-version',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'version.json',
          source: JSON.stringify({ name: 'TmuxGo', version: packageJson.version, buildId }),
        })
      },
    },
  ],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(packageJson.version),
    'import.meta.env.VITE_APP_BUILD_ID': JSON.stringify(buildId),
  },
  build: {
    // 产出 .vite/manifest.json：gateway 的 /api/vnc/client-module 靠它定位 rfb chunk，
    // 不再依赖打包器 chunk 命名（hash/改名会导致该路由静默 404）
    manifest: true,
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      react: fileURLToPath(new URL('../../node_modules/.pnpm/react@18.3.1/node_modules/react', import.meta.url)),
      'react-dom': fileURLToPath(
        new URL('../../node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom', import.meta.url),
      ),
    },
  },
  server: {
    proxy: {
      '/api': { target: process.env.VITE_API_URL || 'http://127.0.0.1:3001', changeOrigin: true, ws: true },
    },
  },
})
