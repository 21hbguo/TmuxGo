import { execTmux } from './tmux-executor.js'

// 任务号写入的唯一实现：人类入口 POST /panes/task 与 agent 控制面 panes/task 共用。
// 存 pane user-option 而不是自建表——tmux 自身是权威源，pane 关掉即随 pane 消失，
// 不需要额外 GC；外部工具（tmux-comm/脚本）也能直接 set-option 写同一个位置。
export function normalizePaneTask(task: string) {
  return task.trim()
}

export async function writePaneTask(hostId: string, tmuxPaneId: string, task: string) {
  // 空 task = 解绑。用 -u 删掉 option 而不是写入空串：空串会在 show-options 里
  // 留下一条 @tmuxgo_task ""，外部工具按「存在即绑定」判断时会误判
  await execTmux(
    hostId,
    task
      ? ['set-option', '-p', '-t', tmuxPaneId, '@tmuxgo_task', task]
      : ['set-option', '-u', '-p', '-t', tmuxPaneId, '@tmuxgo_task'],
  )
}
