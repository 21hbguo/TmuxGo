import { getTemplateWindowTargets, type SessionTemplateLayout } from './template-utils.js'
import { assertSessionAllowed } from './tmux-policy.js'
import { execTmux } from './tmux-executor.js'

// 可注入的 exec：单测传假实现喂固定 tmux 输出，不拉起真实 server
export type TmuxExec = typeof execTmux

/**
 * 建 session 的参数：首 window 首 pane 的 cwd 走 `new-session -c`。
 * window0/pane0 由 new-session 创建，applyTemplateLayout 只给 new-window(i>0) 和
 * split-window 传 cwd；不给 -c 时首 pane 继承 tmux server 的 cwd（远端新起 server = home），
 * 快照恢复出来的首个 pane 就落错目录。cwd 缺失/空白时不传，维持继承 server cwd 的旧行为。
 * `-c` 自 tmux 1.9 起可用，远低于本机与 CI 的 3.4 基线。
 */
export function buildSessionCreateArgs(sessionName: string, layout: SessionTemplateLayout) {
  const args = ['new-session', '-d', '-s', sessionName, '-e', 'TMUXGO_ENV=1']
  const cwd = layout.windows[0]?.panes?.[0]?.cwd?.trim()
  if (cwd) args.push('-c', cwd)
  return args
}

// layout 应用（新建 window / split / select-layout / 打字启动命令）从 sessions 路由抽出，
// 供 session 快照恢复复用：恢复语义 = 同结构 + 同 cwd + 同命令重跑，只有一份实现。
export async function runSendKeys(hostId: string, target: string, command: string, exec: TmuxExec = execTmux) {
  // 目标 pane 若处于 copy/view-mode（如 conf 里 run -b 失败的 run-shell 错误
  // 视图、restore 回放残留），send-keys 会被 mode 按键表拦截派发：绑定命令
  // 在无 client 的 server 上报 "no current client"，且不报错时文本也进 mode
  // 而非 shell。先 best-effort 退 mode（非 mode 时报 not in a mode，吞掉）。
  try {
    await exec(hostId, ['send-keys', '-X', '-t', target, 'cancel'])
  } catch {}
  // 文本走 -l 字面模式 + 独立 Enter：非字面 send-keys 把整串按 key name
  // 逐段解析，空格/--/路径段同样会踩无 client 的派发路径（agent-recovery 同款）
  await exec(hostId, ['send-keys', '-l', '-t', target, command])
  await exec(hostId, ['send-keys', '-t', target, 'Enter'])
}
export function quoteShellValue(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
export function getPaneStartupCommand(pane: { command?: string; cwd?: string; env?: Record<string, string> }) {
  const parts: string[] = []
  const env =
    pane.env && typeof pane.env === 'object'
      ? Object.entries(pane.env).filter(
          ([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string',
        )
      : []
  if (env.length) parts.push(`export ${env.map(([key, value]) => `${key}=${quoteShellValue(value)}`).join(' ')}`)
  // cd 保留：`new-session -c` 只决定创建瞬间的 pwd，shell 的 rc 里若有 cd/自动跳目录
  // （zoxide/chezmoi 之类）仍会把它改掉；这里是在 shell 就绪后再确认一次目录
  if (pane.cwd?.trim()) parts.push(`cd -- ${quoteShellValue(pane.cwd.trim())}`)
  if (pane.command?.trim()) parts.push(pane.command.trim())
  return parts.join('; ')
}
export async function getFirstWindowTarget(hostId: string, sessionName: string, exec: TmuxExec = execTmux) {
  const { stdout } = await exec(hostId, [
    'list-windows',
    '-t',
    sessionName,
    '-F',
    '#{window_index}',
    '-f',
    '#{==:#{window_active},1}',
  ])
  const activeIndex = stdout.trim()
  if (activeIndex) return `${sessionName}:${activeIndex}`
  const { stdout: fallbackStdout } = await exec(hostId, ['list-windows', '-t', sessionName, '-F', '#{window_index}'])
  const fallbackIndex = fallbackStdout.trim().split('\n').find(Boolean)
  if (!fallbackIndex) throw new Error(`No windows found for session ${sessionName}`)
  return `${sessionName}:${fallbackIndex}`
}
export async function getFirstWindowIndex(hostId: string, sessionName: string, exec: TmuxExec = execTmux) {
  const { stdout } = await exec(hostId, ['list-windows', '-t', sessionName, '-F', '#{window_index}'])
  const first = stdout.trim().split('\n').find(Boolean)
  if (!first) throw new Error(`No windows found for session ${sessionName}`)
  const value = Number(first)
  if (!Number.isFinite(value)) throw new Error(`Invalid window index for session ${sessionName}`)
  return value
}
export async function getFirstPaneIndex(hostId: string, windowTarget: string, exec: TmuxExec = execTmux) {
  const { stdout } = await exec(hostId, ['list-panes', '-t', windowTarget, '-F', '#{pane_index}'])
  const first = stdout.trim().split('\n').find(Boolean)
  if (!first) throw new Error(`No panes found for window ${windowTarget}`)
  const value = Number(first)
  if (!Number.isFinite(value)) throw new Error(`Invalid pane index for window ${windowTarget}`)
  return value
}
export async function applyTemplateLayout(
  hostId: string,
  sessionName: string,
  layout: SessionTemplateLayout,
  exec: TmuxExec = execTmux,
) {
  assertSessionAllowed(sessionName)
  if (!layout.windows.length) return
  const firstWindowTarget = await getFirstWindowTarget(hostId, sessionName, exec)
  const firstWindowIndex = await getFirstWindowIndex(hostId, sessionName, exec)
  const targets = getTemplateWindowTargets(sessionName, layout, firstWindowIndex)
  for (let i = 0; i < targets.length; i++) {
    const windowDef = targets[i]
    const { windowTarget, panes } = windowDef
    if (!windowDef.name) throw new Error(`Template step failed: window[${i}] missing name`)
    const splitFlag = windowDef.splitDirection === 'vertical' ? '-v' : '-h'
    const layoutPreset = windowDef.layoutPreset || 'tiled'
    if (i === 0) {
      await exec(hostId, ['rename-window', '-t', firstWindowTarget, windowDef.name])
    } else {
      const args = ['new-window', '-t', sessionName, '-n', windowDef.name]
      if (panes[0]?.cwd?.trim()) args.push('-c', panes[0].cwd.trim())
      await exec(hostId, args)
    }
    const paneBaseIndex =
      i === 0
        ? await getFirstPaneIndex(hostId, firstWindowTarget, exec)
        : await getFirstPaneIndex(hostId, windowTarget, exec)
    for (let p = 1; p < panes.length; p++) {
      await exec(hostId, [
        'split-window',
        '-c',
        panes[p]?.cwd?.trim() || '#{pane_current_path}',
        '-t',
        windowTarget,
        splitFlag,
      ])
    }
    await exec(hostId, ['select-layout', '-t', windowTarget, layoutPreset])
    for (let p = 0; p < panes.length; p++) {
      const command = getPaneStartupCommand(panes[p] || {})
      if (!command) continue
      await runSendKeys(hostId, `${windowTarget}.${paneBaseIndex + p}`, command, exec)
    }
  }
  await exec(hostId, ['select-window', '-t', firstWindowTarget])
}
