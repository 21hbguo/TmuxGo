# Agent 状态监控设计方案

## 目标

在 TmuxGo 中集成多层级（Session → Window → Pane）的 AI Agent 状态监控，实时展示 Claude Code、Codex 等 agent 的运行状态。

## 架构总览

```
┌─────────────────────────────────────────────────────┐
│  Frontend (Next.js)                                 │
│                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────┐  │
│  │ StatusBar    │  │ SessionPanel │  │ AgentBadge│  │
│  │ 状态概览     │  │ 树形状态     │  │ Pane 标记 │  │
│  └──────┬──────┘  └──────┬───────┘  └─────┬─────┘  │
│         └────────────────┼────────────────┘         │
│                    ┌─────┴─────┐                    │
│                    │useAgent   │                    │
│                    │Store      │                    │
│                    └─────┬─────┘                    │
│                          │ WebSocket                │
├──────────────────────────┼──────────────────────────┤
│  Gateway (Fastify)       │                          │
│                    ┌─────┴─────┐                    │
│                    │ Agent     │                    │
│                    │ Monitor   │                    │
│                    └─────┬─────┘                    │
│                          │ 每 2 秒                  │
│                    ┌─────┴─────┐                    │
│                    │ tmux      │                    │
│                    │ list-panes│                    │
│                    └───────────┘                    │
└─────────────────────────────────────────────────────┘
```

## 数据源

### 唯一数据源：tmux list-panes

一条命令获取所有 pane 的完整状态：

```bash
tmux list-panes -a -F \
  '#{session_name}|#{window_index}|#{window_name}|#{pane_id}|#{pane_pid}|#{pane_current_command}|#{pane_bell}|#{pane_activity}|#{pane_silence}'
```

输出示例：

```
claude-project|0|main|%0|12345|bash|0|1780045600|0
claude-project|0|main|%1|12360|claude|0|1780045580|0
claude-project|1|logs|%2|12400|tail|0|1780045500|1
dev|0|editor|%3|13000|codex|0|1780045590|0
```

### 字段说明

| tmux 字段 | 含义 | 用于 |
|-----------|------|------|
| `session_name` | 会话名 | 第一层聚合 |
| `window_index` / `window_name` | 窗口序号和名称 | 第二层聚合 |
| `pane_id` | 面板标识 | 唯一 ID |
| `pane_pid` | 面板进程 PID | 辅助信息 |
| `pane_current_command` | 当前运行的命令 | agent 识别 |
| `pane_bell` | 是否收到 BEL 信号 | attention 状态 |
| `pane_activity` | 最后输出的 Unix 时间戳 | 活跃判断 |
| `pane_silence` | 是否进入静默 | idle 判断 |

## 状态模型

### Agent 识别

根据 `pane_current_command` 判断 agent 类型：

```typescript
function detectAgent(cmd: string): AgentType {
  if (['claude', 'claude-code'].includes(cmd)) return 'claude'
  if (cmd === 'codex') return 'codex'
  if (['bash', 'zsh', 'sh', 'fish'].includes(cmd)) return 'shell'
  if (['node', 'python', 'npm', 'pnpm'].includes(cmd)) return 'runtime'
  return 'other'
}
```

### 状态判定

```typescript
function determineState(pane: TmuxPaneData, now: number): PaneState {
  // 优先级从高到低
  if (pane.bell) return 'attention'        // BEL 信号 = 需要关注
  if (now - pane.activity < 30) return 'working'  // 30 秒内有输出 = 活跃
  if (pane.silence) return 'idle'          // 静默 = 空闲
  return 'idle'                            // 默认空闲
}
```

### 状态定义

| 状态 | 含义 | 触发条件 | 视觉表现 |
|------|------|---------|---------|
| `working` | 正在运行 | 30 秒内有新输出 | 🟢 绿色 |
| `attention` | 需要关注 | 收到 BEL 信号 | 🟡 黄色/闪烁 |
| `idle` | 空闲 | 超过 30 秒无输出 | ⚪ 灰色 |
| `disconnected` | 连接断开 | WebSocket 断开 | 🔴 红色 |

### 三层聚合

```
Pane 状态 → Window 聚合 → Session 聚合
```

聚合规则：取最"活跃"的状态（priority: attention > working > idle）

```typescript
// Window 级别：取其下所有 pane 中最活跃的状态
function aggregateWindowState(panes: PaneState[]): PaneState {
  if (panes.includes('attention')) return 'attention'
  if (panes.includes('working')) return 'working'
  return 'idle'
}

// Session 级别：取其下所有 window 中最活跃的状态
function aggregateSessionState(windows: WindowState[]): PaneState {
  return aggregateWindowState(windows)
}
```

## 后端实现

### 新增文件

```
apps/gateway/src/lib/agent-monitor.ts    # tmux 轮询 + 状态判定
```

### AgentMonitor 类

```typescript
// apps/gateway/src/lib/agent-monitor.ts
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export type AgentType = 'claude' | 'codex' | 'shell' | 'runtime' | 'other'
export type PaneState = 'idle' | 'working' | 'attention' | 'disconnected'

export interface PaneStatus {
  session: string
  windowIndex: number
  windowName: string
  paneId: string
  pid: number
  command: string
  agent: AgentType
  state: PaneState
  bell: boolean
  lastActivity: number
  silent: boolean
}

export interface WindowStatus {
  windowIndex: number
  windowName: string
  panes: PaneStatus[]
  state: PaneState
}

export interface SessionStatus {
  session: string
  windows: WindowStatus[]
  state: PaneState
}

export interface AgentStatusSnapshot {
  type: 'agent-status'
  timestamp: number
  sessions: SessionStatus[]
  flat: PaneStatus[]  // 扁平列表，方便前端直接用
}

const POLL_INTERVAL = 2000
const ACTIVE_THRESHOLD = 30 // 秒

function detectAgent(cmd: string): AgentType {
  if (['claude', 'claude-code'].includes(cmd)) return 'claude'
  if (cmd === 'codex') return 'codex'
  if (['bash', 'zsh', 'sh', 'fish'].includes(cmd)) return 'shell'
  if (['node', 'python', 'npm', 'pnpm'].includes(cmd)) return 'runtime'
  return 'other'
}

function determineState(bell: boolean, lastActivity: number, silent: boolean, now: number): PaneState {
  if (bell) return 'attention'
  if (now - lastActivity < ACTIVE_THRESHOLD) return 'working'
  if (silent) return 'idle'
  return 'idle'
}

export class AgentMonitor {
  private timer: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<(snapshot: AgentStatusSnapshot) => void>()

  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL)
    this.poll() // 立即执行一次
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  onUpdate(listener: (snapshot: AgentStatusSnapshot) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async poll() {
    try {
      const snapshot = await this.scan()
      for (const listener of this.listeners) {
        listener(snapshot)
      }
    } catch {
      // tmux 未运行或其他错误，静默忽略
    }
  }

  private async scan(): Promise<AgentStatusSnapshot> {
    const { stdout } = await execFileAsync('tmux', [
      'list-panes', '-a', '-F',
      '#{session_name}|#{window_index}|#{window_name}|#{pane_id}|#{pane_pid}|#{pane_current_command}|#{pane_bell}|#{pane_activity}|#{pane_silence}'
    ])

    const now = Math.floor(Date.now() / 1000)

    const panes: PaneStatus[] = stdout.trim().split('\n').filter(Boolean).map(line => {
      const [session, winIdx, winName, paneId, pid, cmd, bell, activity, silence] = line.split('|')
      const lastActivity = parseInt(activity, 10) || 0
      const isBell = bell === '1'
      const isSilent = silence === '1'

      return {
        session,
        windowIndex: parseInt(winIdx, 10),
        windowName: winName,
        paneId,
        pid: parseInt(pid, 10),
        command: cmd,
        agent: detectAgent(cmd),
        state: determineState(isBell, lastActivity, isSilent, now),
        bell: isBell,
        lastActivity,
        silent: isSilent,
      }
    })

    // 按 session → window 聚合
    const sessions = this.aggregate(panes)

    return {
      type: 'agent-status',
      timestamp: Date.now(),
      sessions,
      flat: panes,
    }
  }

  private aggregate(panes: PaneStatus[]): SessionStatus[] {
    const sessionMap = new Map<string, Map<string, PaneStatus[]>>()

    for (const pane of panes) {
      if (!sessionMap.has(pane.session)) {
        sessionMap.set(pane.session, new Map())
      }
      const windowMap = sessionMap.get(pane.session)!
      const key = `${pane.windowIndex}`
      if (!windowMap.has(key)) {
        windowMap.set(key, [])
      }
      windowMap.get(key)!.push(pane)
    }

    return Array.from(sessionMap.entries()).map(([session, windowMap]) => {
      const windows: WindowStatus[] = Array.from(windowMap.entries()).map(([, windowPanes]) => ({
        windowIndex: windowPanes[0].windowIndex,
        windowName: windowPanes[0].windowName,
        panes: windowPanes,
        state: this.aggregateState(windowPanes.map(p => p.state)),
      }))

      return {
        session,
        windows,
        state: this.aggregateState(windows.map(w => w.state)),
      }
    })
  }

  private aggregateState(states: PaneState[]): PaneState {
    if (states.includes('attention')) return 'attention'
    if (states.includes('working')) return 'working'
    return 'idle'
  }
}

export const agentMonitor = new AgentMonitor()
```

### Gateway 集成

```typescript
// apps/gateway/src/index.ts 中添加
import { agentMonitor } from './lib/agent-monitor.js'

// 在 WebSocket 连接建立时
agentMonitor.onUpdate((snapshot) => {
  // 广播给所有连接的客户端
  for (const client of connectedClients) {
    client.send(JSON.stringify(snapshot))
  }
})

agentMonitor.start()
```

## 前端实现

### 新增文件

```
apps/frontend/src/stores/useAgentStore.ts     # 状态存储
apps/frontend/src/hooks/useAgentMonitor.ts    # WebSocket 接入
apps/frontend/src/components/AgentStatusBar.tsx  # 状态栏组件
apps/frontend/src/components/AgentSessionBadge.tsx  # Session 标签状态点
```

### 状态存储

```typescript
// apps/frontend/src/stores/useAgentStore.ts
import { create } from 'zustand'
import type { AgentStatusSnapshot, SessionStatus, PaneStatus } from '@/types'

interface AgentState {
  snapshot: AgentStatusSnapshot | null
  update: (snapshot: AgentStatusSnapshot) => void
  getSessionState: (sessionName: string) => SessionStatus | undefined
  getPaneState: (sessionName: string, paneId: string) => PaneStatus | undefined
}

export const useAgentStore = create<AgentState>((set, get) => ({
  snapshot: null,
  update: (snapshot) => set({ snapshot }),
  getSessionState: (sessionName) => {
    return get().snapshot?.sessions.find(s => s.session === sessionName)
  },
  getPaneState: (sessionName, paneId) => {
    return get().snapshot?.flat.find(p => p.session === sessionName && p.paneId === paneId)
  },
}))
```

### WebSocket 接入

```typescript
// apps/frontend/src/hooks/useAgentMonitor.ts
import { useEffect } from 'react'
import { useWebSocket } from './useWebSocket'
import { useAgentStore } from '@/stores/useAgentStore'

export function useAgentMonitor() {
  const { subscribeOutput } = useWebSocket()
  const update = useAgentStore(s => s.update)

  useEffect(() => {
    // 监听 agent-status 消息类型
    // 需要在 useWebSocket 的 handleMessage 中添加对 agent-status 的处理
    const handler = (data: any) => {
      if (data.type === 'agent-status') {
        update(data)
      }
    }
    // 注册到 WebSocket 消息处理链
  }, [update])
}
```

### 状态栏组件

```typescript
// apps/frontend/src/components/AgentStatusBar.tsx
'use client'
import { useAgentStore } from '@/stores/useAgentStore'

const STATE_COLORS = {
  working: 'bg-green-500',
  attention: 'bg-yellow-500 animate-pulse',
  idle: 'bg-gray-400',
  disconnected: 'bg-red-500',
}

const AGENT_LABELS = {
  claude: 'Claude',
  codex: 'Codex',
  shell: 'Shell',
  runtime: 'Process',
  other: 'Other',
}

export function AgentStatusBar() {
  const snapshot = useAgentStore(s => s.snapshot)

  if (!snapshot) return null

  // 只显示有 agent 的 session
  const agentSessions = snapshot.sessions.filter(s =>
    s.windows.some(w =>
      w.panes.some(p => ['claude', 'codex'].includes(p.agent))
    )
  )

  if (agentSessions.length === 0) return null

  return (
    <div className="flex items-center gap-3 text-xs">
      {agentSessions.map(session => (
        <div key={session.session} className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${STATE_COLORS[session.state]}`} />
          <span className="text-[var(--fg-2)]">{session.session}</span>
        </div>
      ))}
    </div>
  )
}
```

### Session 标签状态点

在现有的 Session 标签旁边加一个小圆点：

```typescript
// SessionPanel 中 session 名称旁
const sessionState = useAgentStore(s => s.getSessionState(session.name))

<span className={`w-1.5 h-1.5 rounded-full ${STATE_COLORS[sessionState?.state || 'idle']}`} />
```

## 前端展示方案

### 方案 A：StatusBar 增强（推荐，最轻量）

```
[Connected]  claude-project: ● codex ●  dev: ○
```

在现有 StatusBar 右侧追加 agent 状态指示器。

### 方案 B：Session 标签状态点

```
| ● claude-project | ○ dev | + |
```

在每个 session 名称前加状态圆点。

### 方案 C：侧栏树形状态（信息最全）

```
▸ claude-project ●
  ├─ main ●
  │  ├─ claude  🟢 working
  │  ├─ codex   ⚪ idle
  │  └─ shell   ⚪ idle
  └─ logs ○
     └─ tail    ⚪ idle
```

展开 session/window 时显示 pane 级别状态。

## 性能开销

| 操作 | 频率 | 耗时 | 说明 |
|------|------|------|------|
| `tmux list-panes` | 每 2 秒 | <5ms | 单条 shell 命令 |
| JSON 序列化 | 每 2 秒 | <1ms | 状态数据量小 |
| WebSocket 广播 | 每 2 秒 | <1ms | 仅变化时推送 |
| 前端聚合 | 每 2 秒 | <1ms | 数组遍历 |

**总计：每 2 秒 <10ms，对系统无感知影响。**

## 实现步骤

### Phase 1：基础监控

- [ ] Gateway：实现 `AgentMonitor` 类
- [ ] Gateway：WebSocket 广播 `agent-status` 消息
- [ ] Frontend：`useAgentStore` 状态存储
- [ ] Frontend：`useAgentMonitor` 接入 WebSocket
- [ ] Frontend：StatusBar 显示 agent 状态点

### Phase 2：增强展示

- [ ] Session 标签旁显示状态点
- [ ] 侧栏树形 pane 状态（可选）
- [ ] 状态变更动画过渡

### Phase 3：高级功能（按需）

- [ ] tmux bell 增强：Claude Code 完成时主动发 BEL
- [ ] 文件监控增强：读取 `~/.claude/sessions/*.json` 匹配 agent 元数据
- [ ] 通知：agent 完成或出错时弹 toast
- [ ] 历史统计：agent 运行时长、输出量等
