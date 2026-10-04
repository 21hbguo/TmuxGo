import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

// tmux ignores TMUX_TMPDIR when TMUX is inherited; all test-server lifecycle
// operations therefore use the exact socket path and an explicitly cleared TMUX.
export function tmuxSocketPath(tmuxDir: string) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  return join(tmuxDir, `tmux-${uid}`, 'default')
}

export function prepareTmuxSocketDir(tmuxDir: string) {
  mkdirSync(join(tmuxDir, `tmux-${typeof process.getuid === 'function' ? process.getuid() : 0}`), {
    recursive: true,
    mode: 0o700,
  })
}

export function tmuxTestEnv(tmuxDir: string, baseEnv: NodeJS.ProcessEnv = process.env) {
  return { ...baseEnv, TMUX: '', TMUX_TMPDIR: tmuxDir }
}
