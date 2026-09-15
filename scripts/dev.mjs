import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const npmCmd = isWin ? 'npm.cmd' : 'npm'
const tasks = [
  { name: 'frontend', cwd: path.join(root, 'apps/frontend') },
  { name: 'gateway', cwd: path.join(root, 'apps/gateway') },
]
const children = tasks.map((task) => {
  const child = spawn(npmCmd, ['run', 'dev'], { cwd: task.cwd, stdio: 'inherit', env: process.env, detached: !isWin })
  child.on('error', (err) => {
    console.error(`[dev] ${task.name} failed to start:`, err.message)
    shutdown(1)
  })
  child.on('exit', (code, signal) => {
    if (exiting) return
    console.error(`[dev] ${task.name} exited (${signal || code}); stopping the rest`)
    shutdown(typeof code === 'number' ? code : 1)
  })
  return child
})
let exiting = false
function killChild(child, signal) {
  try {
    if (isWin || !child.pid) child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch {}
}
function shutdown(code) {
  if (exiting) return
  exiting = true
  for (const child of children) killChild(child, 'SIGTERM')
  setTimeout(() => {
    for (const child of children) killChild(child, 'SIGKILL')
    process.exit(code ?? 0)
  }, 3000).unref()
}
process.on('SIGINT', () => shutdown(130))
process.on('SIGTERM', () => shutdown(143))
