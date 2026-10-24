import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import test from 'node:test'
import {
  closeAgentTodosForPane,
  kindOf,
  listAgentTodoQueue,
  persistAgentNotification,
  reconcileTodoQueue,
  todoStateOf,
  type AgentNotificationRecord,
  type AgentTodoItem,
} from './agent-notifications.js'
import Fastify from 'fastify'
import { agentNotificationRoutes } from '../routes/agent-notifications.js'
import type { AgentPaneState } from './agent-state.js'

/**
 * 待办队列（agent v2 P2）：分类映射、pane 聚合、pane 消失收口、实时纠正、懒迁移。
 */

async function withConfigDir(t: { after: (fn: () => Promise<void>) => void }) {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-todo-queue-'))
  const previous = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = configDir
  t.after(async () => {
    if (previous === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previous
    await rm(configDir, { recursive: true, force: true })
  })
  return configDir
}

function pane(overrides: Partial<AgentPaneState> = {}): AgentPaneState {
  return {
    paneId: 'local:%1',
    tmuxPaneId: '%1',
    sessionName: 'dev',
    agent: 'codex',
    agentStatus: 'blocked',
    revision: 1,
    ...overrides,
  }
}

test('todoStateOf/kindOf 把通知状态映射成待办语义', () => {
  // 需要人处理
  assert.equal(todoStateOf('permission_required'), 'blocked')
  assert.equal(todoStateOf('needs_input'), 'blocked')
  assert.equal(todoStateOf('blocked'), 'blocked')
  // 已终结：可以打勾回看
  assert.equal(todoStateOf('done'), 'done')
  assert.equal(todoStateOf('ended'), 'done')
  assert.equal(todoStateOf('failed'), 'done')
  // 断连是环境状态，不是待办
  assert.equal(kindOf('disconnected'), 'info')
  assert.equal(kindOf('blocked'), 'todo')
})

test('persist 落库时快照任务号并带待办分类', async (t) => {
  await withConfigDir(t)
  const record = await persistAgentNotification({
    type: 'agent_notification',
    hostId: 'local',
    sessionName: 'dev',
    eventId: 'event-1',
    pane: pane({ phase: 'permission_required', lastEvent: 'permission_required', task: 'T-237:待办队列' }),
  })
  assert.ok(record)
  assert.equal(record.kind, 'todo')
  assert.equal(record.todoState, 'blocked')
  // 快照是原样，不做解析（UI 负责只渲染冒号前的 id）
  assert.equal(record.task, 'T-237:待办队列')

  const queue = await listAgentTodoQueue()
  assert.equal(queue.counts.blocked, 1)
  assert.equal(queue.blocked[0]?.task, 'T-237:待办队列')
})

test('同一 pane 的连续通知在队列里只占一行，状态取最新', async (t) => {
  await withConfigDir(t)
  await persistAgentNotification({
    type: 'agent_notification',
    hostId: 'local',
    sessionName: 'dev',
    eventId: 'event-1',
    pane: pane({ phase: 'permission_required', lastEvent: 'permission_required' }),
  })
  await persistAgentNotification({
    type: 'agent_notification',
    hostId: 'local',
    sessionName: 'dev',
    eventId: 'event-2',
    pane: pane({ phase: 'ended', lastEvent: 'completed', agentStatus: 'done' }),
  })
  // 通知本身两条都留着（回看/审计），队列只投影一条
  const queue = await listAgentTodoQueue()
  assert.equal(queue.counts.blocked, 0)
  assert.equal(queue.counts.done, 1)
  assert.equal(queue.done[0]?.id, 'event-2')
  assert.equal(queue.done.length + queue.blocked.length + queue.pending.length, 1)
})

test('pane 消失时把未完成待办收口为 done', async (t) => {
  await withConfigDir(t)
  await persistAgentNotification({
    type: 'agent_notification',
    hostId: 'local',
    sessionName: 'dev',
    eventId: 'event-1',
    pane: pane({ phase: 'needs_input', lastEvent: 'question_required' }),
  })
  const changed = await closeAgentTodosForPane('local', 'local:%1')
  assert.equal(changed, 1)
  const queue = await listAgentTodoQueue()
  assert.equal(queue.counts.blocked, 0)
  assert.equal(queue.counts.done, 1)
  // 幂等：再来一次没有可改的
  assert.equal(await closeAgentTodosForPane('local', 'local:%1'), 0)
  // 别的 pane 不受影响
  assert.equal(await closeAgentTodosForPane('local', 'local:%99'), 0)
})

test('实时阶段纠正 blocked↔pending，避免队列停在过期快照上', () => {
  const item = (id: string, state: 'blocked' | 'pending') =>
    ({
      id,
      eventId: id,
      hostId: 'local',
      sessionName: 'dev',
      paneId: id,
      agent: 'codex',
      status: state === 'blocked' ? 'blocked' : 'done',
      message: 'x',
      timestamp: new Date().toISOString(),
      readBy: [],
      kind: 'todo',
      todoState: state,
    }) as AgentTodoItem

  const queue = reconcileTodoQueue(
    {
      blocked: [item('local:%1', 'blocked'), item('local:%2', 'blocked')],
      pending: [item('local:%3', 'pending')],
      done: [],
      counts: { blocked: 2, pending: 1, done: 0 },
    },
    new Map([
      // %1 自己继续跑了 → pending（不用人管）
      ['local:%1', { phase: 'working' }],
      // %2 还卡着 → 保持 blocked
      ['local:%2', { phase: 'permission_required' }],
      // %3 卡住了 → 升级 blocked
      ['local:%3', { phase: 'needs_input' }],
    ]),
  )
  assert.deepEqual(queue.blocked.map((entry) => entry.id).sort(), ['local:%2', 'local:%3'])
  assert.deepEqual(
    queue.pending.map((entry) => entry.id),
    ['local:%1'],
  )
  assert.equal(queue.counts.blocked, 2)
  assert.equal(queue.counts.pending, 1)
  // 纠正只改视图，不改对象本身
  assert.equal(queue.pending[0]?.todoState, 'pending')
})

test('老记录没有 kind/todoState 时读时懒迁移，不写回也不丢数据', async (t) => {
  const configDir = await withConfigDir(t)
  // 直接写一条 v1 形状的记录（没有三个新字段），模拟升级前的存量
  const storePath = path.join(configDir, 'agent-notifications.json')
  await writeFile(
    storePath,
    JSON.stringify({
      version: 1,
      vapid: { subject: 'mailto:test@example.com', publicKey: 'x', privateKey: 'y' },
      subscriptions: [],
      notifications: [
        {
          id: 'legacy-1',
          eventId: 'legacy-1',
          hostId: 'local',
          sessionName: 'dev',
          paneId: 'local:%7',
          agent: 'claude',
          status: 'permission_required',
          message: 'claude is waiting for permission',
          timestamp: new Date().toISOString(),
          readBy: [],
        },
      ],
    }),
  )
  const queue = await listAgentTodoQueue()
  assert.equal(queue.counts.blocked, 1)
  assert.equal(queue.blocked[0]?.todoState, 'blocked')
  assert.equal(queue.blocked[0]?.kind, 'todo')
  // 懒迁移是只读投影：磁盘上那条记录一个字段都没被改写
  const onDisk = JSON.parse(await readFile(storePath, 'utf8')) as {
    notifications: Array<Record<string, unknown>>
  }
  assert.equal(onDisk.notifications[0].todoState, undefined)
  assert.equal(onDisk.notifications[0].kind, undefined)
})

test('unread 响应保持旧字段不变，只增量补 messagesUnread/tasksBlocked', async (t) => {
  await withConfigDir(t)
  await persistAgentNotification({
    type: 'agent_notification',
    hostId: 'local',
    sessionName: 'dev',
    eventId: 'event-unread',
    pane: pane({ phase: 'permission_required', lastEvent: 'permission_required', task: 'T-237' }),
  })
  const fastify = Fastify()
  await fastify.register(agentNotificationRoutes)
  t.after(() => void fastify.close())

  const legacy = await fastify.inject({
    method: 'GET',
    url: '/agent-notifications/unread?deviceId=dev-1&limit=10',
  })
  assert.equal(legacy.statusCode, 200)
  const body = legacy.json() as {
    notifications: AgentNotificationRecord[]
    messagesUnread: number
    tasksBlocked: number
  }
  // 老客户端只读 notifications：数组形状与条数一点没变
  assert.equal(body.notifications.length, 1)
  assert.equal(body.notifications[0]?.id, 'event-unread')
  // 新计数：消息未读 != 待处理待办（这里恰好都是 1，靠 tasks 语义区分）
  assert.equal(body.messagesUnread, 1)
  assert.equal(body.tasksBlocked, 1)

  const tasks = await fastify.inject({ method: 'GET', url: '/agent-notifications/tasks' })
  assert.equal(tasks.statusCode, 200)
  const queue = tasks.json() as { blocked: AgentTodoItem[]; pending: AgentTodoItem[]; done: AgentTodoItem[] }
  assert.equal(queue.blocked.length, 1)
  assert.equal(queue.pending.length, 0)
  assert.equal(queue.done.length, 0)
})
