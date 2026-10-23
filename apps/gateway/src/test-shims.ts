// 仅测试用的外部命令桩：把假 ssh / 假 sshpass / 记录型 systemd-run 前置进 PATH。
// 目的是让「外部命令怎么失败」成为可断言的输入（SSH 错误分类、sshpass 分支、
// systemd-run 冷启动），而不需要真 SSH server；刻意不伪造 tmux 二进制——
// tmux 版本分支必须由真实 tmux 验证。
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type ShimName = 'ssh' | 'sshpass' | 'systemd-run'

// 每次调用把 argv（tab 分隔）与 SSHPASS 追加进 $SHIM_LOG，供用例断言。
// 失败剧本由环境变量给出，且按通道分开：直接 ssh（无 SSHPASS）用 SHIM_SSH_*，
// sshpass 转发进来的 ssh（SSHPASS 在环境里）用 SHIM_PASSWORD_*——这样才能复现
// 「密钥通道失败但密码通道可用」这种真实组合。
const SSH_SHIM = `#!/bin/sh
{
  printf 'ssh'
  for a in "$@"; do printf '\\t%s' "$a"; done
  printf '\\nSSHPASS=%s\\n' "\${SSHPASS:-}"
} >> "$SHIM_LOG"
# 上传通道要断言「真实字节到了远端」：把 stdin 落到 SHIM_CAPTURE_FILE 再按剧本退出
if [ -n "\${SHIM_CAPTURE_FILE:-}" ]; then cat > "$SHIM_CAPTURE_FILE"; fi
if [ -n "\${SSHPASS:-}" ]; then
  printf '%s' "\${SHIM_PASSWORD_STDOUT:-}"
  printf '%s' "\${SHIM_PASSWORD_STDERR:-}" >&2
  exit "\${SHIM_PASSWORD_EXIT:-0}"
fi
printf '%s' "\${SHIM_SSH_STDOUT:-}"
printf '%s' "\${SHIM_SSH_STDERR:-}" >&2
exit "\${SHIM_SSH_EXIT:-0}"
`

// sshpass -V 是 hasSshPass() 的探测调用，必须成功返回，否则整个 sshpass 分支被判缺失。
// 其余调用把参数原样转给桩 ssh（真实 sshpass 也是 exec ssh），SSHPASS 仍留在环境里。
const SSHPASS_SHIM = `#!/bin/sh
if [ "$1" = "-V" ]; then printf 'sshpass 1.10\\n'; exit 0; fi
{
  printf 'sshpass'
  for a in "$@"; do printf '\\t%s' "$a"; done
  printf '\\nSSHPASS=%s\\n' "\${SSHPASS:-}"
} >> "$SHIM_LOG"
shift
exec ssh "$@"
`

// 记录后转交真实 systemd-run：证明 executor 在 INVOCATION_ID 存在时确实换了启动器，
// 又不改变冷启动的真实语义。
const SYSTEMD_RUN_SHIM = `#!/bin/sh
{
  printf 'systemd-run'
  for a in "$@"; do printf '\\t%s' "$a"; done
  printf '\\n'
} >> "$SHIM_LOG"
exec "$SHIM_SYSTEMD_RUN_REAL" "$@"
`

const SCRIPTS: Record<ShimName, string> = {
  ssh: SSH_SHIM,
  sshpass: SSHPASS_SHIM,
  'systemd-run': SYSTEMD_RUN_SHIM,
}

export interface Shims {
  dir: string
  log: string
  readLog: () => string[]
  // 某类桩被调用的次数（按日志首列统计）
  count: (name: ShimName) => number
  restore: () => void
}

export function installShims(names: ShimName[], options: { systemdRunPath?: string } = {}): Shims {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-shims-'))
  const log = path.join(dir, 'calls.log')
  writeFileSync(log, '')
  for (const name of names) {
    const file = path.join(dir, name)
    writeFileSync(file, SCRIPTS[name])
    chmodSync(file, 0o755)
  }
  const previous = {
    PATH: process.env.PATH,
    SHIM_LOG: process.env.SHIM_LOG,
    SHIM_SYSTEMD_RUN_REAL: process.env.SHIM_SYSTEMD_RUN_REAL,
  }
  process.env.PATH = `${dir}:${previous.PATH ?? '/usr/bin:/bin'}`
  process.env.SHIM_LOG = log
  if (options.systemdRunPath) process.env.SHIM_SYSTEMD_RUN_REAL = options.systemdRunPath
  const readLog = () => readFileSync(log, 'utf8').split('\n').filter(Boolean)
  return {
    dir,
    log,
    readLog,
    count: (name) => readLog().filter((line) => line.split('\t')[0] === name).length,
    restore: () => {
      if (previous.PATH === undefined) delete process.env.PATH
      else process.env.PATH = previous.PATH
      if (previous.SHIM_LOG === undefined) delete process.env.SHIM_LOG
      else process.env.SHIM_LOG = previous.SHIM_LOG
      if (previous.SHIM_SYSTEMD_RUN_REAL === undefined) delete process.env.SHIM_SYSTEMD_RUN_REAL
      else process.env.SHIM_SYSTEMD_RUN_REAL = previous.SHIM_SYSTEMD_RUN_REAL
      for (const key of [
        'SHIM_SSH_STDOUT',
        'SHIM_SSH_STDERR',
        'SHIM_SSH_EXIT',
        'SHIM_PASSWORD_STDOUT',
        'SHIM_PASSWORD_STDERR',
        'SHIM_PASSWORD_EXIT',
        'SHIM_CAPTURE_FILE',
      ])
        delete process.env[key]
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

// 断言辅助：取某种桩最后一次调用的参数（不含首列命令名）
export function lastShimArgs(shims: Shims, name: ShimName): string[] | null {
  const lines = shims.readLog().filter((line) => line.split('\t')[0] === name)
  const last = lines.at(-1)
  return last ? last.split('\t').slice(1) : null
}
