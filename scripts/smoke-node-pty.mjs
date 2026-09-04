import * as pty from 'node-pty'

const terminal = pty.spawn('/bin/bash', ['-lc', 'echo PTY_ENGINE_OK'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env })
let output = ''
const timeout = setTimeout(() => {
  terminal.kill()
  console.error('PTY engine smoke test timed out')
  process.exit(1)
}, 5000)
terminal.onData((data) => {
  output += data
})
terminal.onExit(({ exitCode }) => {
  clearTimeout(timeout)
  if (exitCode !== 0 || !output.includes('PTY_ENGINE_OK')) {
    console.error(output || 'PTY engine smoke test failed')
    process.exit(1)
  }
  process.stdout.write('PTY_ENGINE_OK\n')
})
