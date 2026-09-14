import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
process.chdir(packageRoot)
process.env.NODE_ENV = 'production'
process.env.PORT ||= '3001'
process.env.TMUXGO_HOST ||= '127.0.0.1'
process.env.TMUXGO_FRONTEND_DIST ||= join(packageRoot, 'vendor', 'frontend')
await import(pathToFileURL(join(packageRoot, 'vendor', 'gateway', 'index.js')).href)
