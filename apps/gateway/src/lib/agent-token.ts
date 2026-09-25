import { randomBytes } from 'crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

// agent event token 生命周期自管理：
//   1. 显式 env（TMUXGO_AGENT_EVENT_TOKEN）优先，并回落写盘供本地 agent/bridge 自取
//   2. 无 env 时读 ~/.tmuxgo/agent-event-token（0600）
//   3. 都没有则首启自动生成并落盘——控制面开箱即用，不必手工配 token
// 文件仅本机同 uid 可读，与 agent-history.json 等同信任域。
let cached: string | null = null

function configDir() {
  return process.env.TMUXGO_CONFIG_DIR?.trim() || path.join(os.homedir(), '.tmuxgo')
}
export function agentEventTokenPath() {
  return path.join(configDir(), 'agent-event-token')
}
function persistTokenFile(token: string) {
  try {
    const dir = configDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(agentEventTokenPath(), `${token}\n`, { mode: 0o600 })
    chmodSync(agentEventTokenPath(), 0o600)
  } catch {
    // 落盘失败不影响 env 来源的可用性
  }
}
export function resolveAgentEventToken() {
  if (cached !== null) return cached
  const env = process.env.TMUXGO_AGENT_EVENT_TOKEN?.trim()
  if (env) {
    cached = env
    persistTokenFile(env)
    return cached
  }
  let fromFile = ''
  try {
    fromFile = readFileSync(agentEventTokenPath(), 'utf8').trim()
  } catch {}
  if (fromFile) {
    cached = fromFile
    return cached
  }
  cached = randomBytes(32).toString('hex')
  persistTokenFile(cached)
  return cached
}
// 测试用：清缓存让下一个 resolve 重新走 env/file 解析
export function _resetAgentEventTokenForTest() {
  cached = null
}
