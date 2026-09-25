// pane 环境注入集：agent 在 pane 里回调 control plane 所需的全部变量。
// 沿用现有机制——创建命令带 `-e TMUXGO_ENV=1` 时 executor 先 setenv -g 全部条目，
// 新 pane/其后代从 tmux 全局环境继承；显式 -e 只标记触发，不逐条进 argv。
export function getTmuxEnvEntries(hostId: string): string[] {
  const entries = ['TMUXGO_ENV=1']
  const token = process.env.TMUXGO_AGENT_EVENT_TOKEN?.trim()
  if (token) entries.push(`TMUXGO_AGENT_EVENT_TOKEN=${token}`)
  // 远端 host 的 127.0.0.1 无意义：本地才注 URL；远端如需走通网关，
  // 用 TMUXGO_ADVERTISE_URL 显式宣告可达地址
  const advertise = process.env.TMUXGO_ADVERTISE_URL?.trim()
  if (advertise) entries.push(`TMUXGO_GATEWAY_URL=${advertise}`)
  else if (hostId === 'local') entries.push(`TMUXGO_GATEWAY_URL=http://127.0.0.1:${process.env.PORT || '3001'}`)
  return entries
}
export function isTmuxGoEnvArg(value: string) {
  return /^TMUXGO_(ENV|AGENT_EVENT_TOKEN|GATEWAY_URL)=/.test(value)
}
