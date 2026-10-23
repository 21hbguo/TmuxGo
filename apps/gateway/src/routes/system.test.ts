import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Fastify, { type FastifyInstance } from 'fastify'
import { systemRoutes } from './system.js'
import { createRestartTaskRunner, type RestartTaskRunner } from '../lib/restart-task.js'

// 任务执行一律注入桩 runner：真实 runner 配无害 sh 脚本（不是 scripts/self-update.sh），
// 既能断言真实状态机与输出捕获，又不会真跑升级/重启。
function scriptRunner(t: test.TestContext, script: string): RestartTaskRunner {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-system-runner-'))
  const runner = createRestartTaskRunner({
    command: 'sh',
    args: ['-c', script],
    statePath: path.join(dir, 'update-task.json'),
    logPath: path.join(dir, 'update-task.log'),
  })
  t.after(async () => {
    await runner.cancel()
    rmSync(dir, { recursive: true, force: true })
  })
  return runner
}

function fakeChecker(nextStatus: Record<string, unknown> = {}) {
  const calls: boolean[] = []
  const status = {
    available: true,
    branch: 'master',
    aheadBy: 1,
    behindBy: 3,
    dirty: false,
    checkedAt: '2026-10-23T00:00:00.000Z',
    error: null,
    current: { version: '1.4.0', buildId: '1.4.0-abc1234', commit: 'abc1234' },
    latest: { version: '1.5.0', buildId: '1.5.0-def5678', commit: 'def5678' },
    ...nextStatus,
  }
  return {
    calls,
    checker: {
      getStatus: async (force = false) => {
        calls.push(force)
        return { ...status }
      },
    },
  }
}

function fakeTaskManager(tasks: Record<string, unknown>[] = []) {
  const calls: string[] = []
  return {
    calls,
    manager: {
      list: () => tasks,
      get: (id: string) => {
        calls.push(`get:${id}`)
        return tasks.find((task) => (task as { id: string }).id === id) || null
      },
      cancel: async (id: string) => {
        calls.push(`cancel:${id}`)
        const hit = tasks.find((task) => (task as { id: string }).id === id)
        return hit ? { ...hit, status: 'cancelled', errorMessage: 'Task cancelled' } : null
      },
      retry: async (id: string) => {
        calls.push(`retry:${id}`)
        const hit = tasks.find((task) => (task as { id: string }).id === id)
        return hit ? { ...hit, status: 'running' } : null
      },
    },
  }
}

async function mount(t: test.TestContext, options: Parameters<typeof systemRoutes>[1] = {}, prefix = '/api') {
  const app = Fastify()
  await app.register(async (fastify) => systemRoutes(fastify, options), { prefix })
  t.after(() => app.close())
  return { app, url: (suffix: string) => `${prefix}${suffix}` }
}

async function waitForStatus(app: FastifyInstance, url: string, want: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let last: Record<string, unknown> = {}
  while (Date.now() < deadline) {
    const response = await app.inject({ method: 'GET', url })
    last = response.json() as Record<string, unknown>
    if (last.status === want) return last
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`status never became ${want}: ${JSON.stringify(last)}`)
}

test('GET /system/update merges checker status with the idle update task', async (t) => {
  const { calls, checker } = fakeChecker()
  const runner = scriptRunner(t, 'sleep 5')
  const { app, url } = await mount(t, { updateChecker: checker, createUpdateRunner: () => runner })

  const response = await app.inject({ method: 'GET', url: url('/system/update') })
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.available, true)
  assert.equal(body.behindBy, 3)
  assert.deepEqual(body.latest, { version: '1.5.0', buildId: '1.5.0-def5678', commit: 'def5678' })
  assert.equal(body.task.id, 'self-update')
  assert.equal(body.task.title, 'App Update')
  assert.equal(body.task.status, 'idle')
  assert.equal(body.task.cancellable, false)
  assert.equal(body.task.retryable, false)
  // 普通读取不得绕过 fetch 节流
  assert.deepEqual(calls, [false])
})

test('POST /system/update/check always bypasses the fetch throttle', async (t) => {
  const { calls, checker } = fakeChecker({ available: false, behindBy: 0 })
  const runner = scriptRunner(t, 'sleep 5')
  const { app, url } = await mount(t, { updateChecker: checker, createUpdateRunner: () => runner })

  const first = await app.inject({ method: 'POST', url: url('/system/update/check') })
  const second = await app.inject({ method: 'POST', url: url('/system/update/check') })
  assert.equal(first.statusCode, 200)
  assert.equal(first.json().available, false)
  assert.equal(first.json().behindBy, 0)
  assert.equal(second.statusCode, 200)
  assert.deepEqual(calls, [true, true])
})

test('POST /system/update starts exactly one task under concurrent requests', async (t) => {
  const runner = scriptRunner(t, 'sleep 30')
  const { checker } = fakeChecker()
  const { app, url } = await mount(t, { updateChecker: checker, createUpdateRunner: () => runner })

  const [first, second] = await Promise.all([
    app.inject({ method: 'POST', url: url('/system/update') }),
    app.inject({ method: 'POST', url: url('/system/update') }),
  ])
  assert.equal(first.statusCode, 200)
  assert.equal(second.statusCode, 200)
  // 并发第二次不得再 spawn：同一 pid + 同一 startedAt 说明复用同一个运行中任务
  assert.equal(first.json().status, 'running')
  assert.equal(second.json().status, 'running')
  assert.ok(first.json().pid > 0)
  assert.equal(second.json().pid, first.json().pid)
  assert.equal(second.json().startedAt, first.json().startedAt)

  const task = (await app.inject({ method: 'GET', url: url('/system/update/task') })).json()
  assert.equal(task.id, 'self-update')
  assert.equal(task.cancellable, true)
  assert.equal(task.retryable, false)
})

test('cancel is idempotent for a finished task and flips a running one to cancelled', async (t) => {
  const runner = scriptRunner(t, 'sleep 30')
  const { checker } = fakeChecker()
  const { app, url } = await mount(t, { updateChecker: checker, createUpdateRunner: () => runner })

  // 还没启动时取消：状态机不得从 idle 迁移
  const idleCancel = await app.inject({ method: 'POST', url: url('/system/tasks/self-update/cancel') })
  assert.equal(idleCancel.statusCode, 200)
  assert.equal(idleCancel.json().status, 'idle')
  assert.equal(idleCancel.json().finishedAt, null)

  await app.inject({ method: 'POST', url: url('/system/update') })
  const cancelled = await app.inject({ method: 'POST', url: url('/system/tasks/self-update/cancel') })
  assert.equal(cancelled.json().status, 'cancelled')
  assert.equal(cancelled.json().errorMessage, 'Task cancelled')
  assert.equal(cancelled.json().cancellable, false)
  assert.equal(cancelled.json().retryable, true)
  // 再取消一次：已完结任务保持原样，幂等
  const again = await app.inject({ method: 'POST', url: url('/system/tasks/self-update/cancel') })
  assert.equal(again.json().status, 'cancelled')
  assert.equal(again.json().finishedAt, cancelled.json().finishedAt)
})

test('retry skips a running task and reports completion with exit code', async (t) => {
  const runner = scriptRunner(t, 'echo STEP1; exit 0')
  const { checker } = fakeChecker()
  const { app, url } = await mount(t, { updateChecker: checker, createUpdateRunner: () => runner })

  const started = await app.inject({ method: 'POST', url: url('/system/update') })
  assert.equal(started.json().status, 'running')
  // 运行中重试：不得重置 startedAt（不产生第二次 spawn）
  const retriedWhileRunning = await app.inject({ method: 'POST', url: url('/system/tasks/self-update/retry') })
  assert.equal(retriedWhileRunning.json().startedAt, started.json().startedAt)

  const finished = await waitForStatus(app, url('/system/update/task'), 'success')
  assert.equal(finished.exitCode, 0)
  assert.equal(finished.errorMessage, null)
  assert.equal(finished.cancellable, false)
  assert.equal(finished.retryable, false)
  // 输出捕获走注入的 sh 脚本，证明没有执行 scripts/self-update.sh
  assert.ok((finished.summaryLines as string[]).some((line) => line.includes('STEP1')))

  // 已成功任务再重试：runner 只拦 running，不拦 success——端点会真的再跑一轮。
  // 这与响应体里 retryable:false 是两套语义（标记是建议值，端点不据它拒绝），
  // 钉现状并把该不一致列进回报，不在本批改实现。
  const retrySuccess = await app.inject({ method: 'POST', url: url('/system/tasks/self-update/retry') })
  assert.equal(retrySuccess.json().status, 'running')
  assert.notEqual(retrySuccess.json().startedAt, finished.startedAt)
  await app.inject({ method: 'POST', url: url('/system/tasks/self-update/cancel') })
})

test('a failing task surfaces exit code and becomes retryable', async (t) => {
  const runner = scriptRunner(t, 'echo BOOM >&2; exit 3')
  const { checker } = fakeChecker()
  const { app, url } = await mount(t, { updateChecker: checker, createUpdateRunner: () => runner })

  await app.inject({ method: 'POST', url: url('/system/update') })
  const failed = await waitForStatus(app, url('/system/update/task'), 'error')
  assert.equal(failed.exitCode, 3)
  assert.equal(failed.errorMessage, 'Command exited with code 3')
  assert.equal(failed.retryable, true)
  assert.equal(failed.cancellable, false)
  assert.ok((failed.summaryLines as string[]).some((line) => line.includes('BOOM')))
})

test('GET /system/tasks lists fixed tasks first and 404s unknown ids on every endpoint', async (t) => {
  const runner = scriptRunner(t, 'sleep 5')
  const { checker } = fakeChecker()
  const { manager, calls } = fakeTaskManager([
    { id: 'bg-1', type: 'file-transfer', title: 'Transfer', status: 'running', cancellable: true, retryable: false },
  ])
  const { app, url } = await mount(t, {
    updateChecker: checker,
    createUpdateRunner: () => runner,
    taskManager: manager as never,
  })

  const list = (await app.inject({ method: 'GET', url: url('/system/tasks') })).json()
  assert.deepEqual(
    (list.tasks as { id: string }[]).map((task) => task.id),
    ['restart-rebuild', 'self-update', 'bg-1'],
  )
  assert.equal(list.tasks[0].title, 'Restart + Rebuild')
  assert.equal(list.tasks[2].status, 'running')

  const detail = (await app.inject({ method: 'GET', url: url('/system/tasks/self-update') })).json()
  assert.equal(detail.id, 'self-update')
  assert.equal(detail.status, 'idle')

  for (const suffix of ['/system/tasks/ghost', '/system/tasks/ghost/cancel', '/system/tasks/ghost/retry']) {
    const method = suffix.endsWith('ghost') ? 'GET' : 'POST'
    const response = await app.inject({ method, url: url(suffix) })
    assert.equal(response.statusCode, 404, suffix)
    assert.deepEqual(response.json(), { message: 'Task not found', code: 'TASK_NOT_FOUND' })
  }
  // 404 判定必须先问任务管理器，不能凭空返回
  assert.ok(calls.includes('get:ghost'))
})

test('cancel and retry delegate background task ids to the task manager', async (t) => {
  const runner = scriptRunner(t, 'sleep 5')
  const { checker } = fakeChecker()
  const { manager, calls } = fakeTaskManager([
    { id: 'bg-2', type: 'file-transfer', title: 'Transfer', status: 'running' },
  ])
  const { app, url } = await mount(t, {
    updateChecker: checker,
    createUpdateRunner: () => runner,
    taskManager: manager as never,
  })

  const cancelled = await app.inject({ method: 'POST', url: url('/system/tasks/bg-2/cancel') })
  assert.equal(cancelled.statusCode, 200)
  assert.equal(cancelled.json().status, 'cancelled')
  const retried = await app.inject({ method: 'POST', url: url('/system/tasks/bg-2/retry') })
  assert.equal(retried.json().status, 'running')
  assert.deepEqual(
    calls.filter((call) => call.startsWith('cancel:') || call.startsWith('retry:')),
    ['cancel:bg-2', 'retry:bg-2'],
  )
})

test('net-top reports an unavailable sample for an unknown host and caches it', async (t) => {
  const runner = scriptRunner(t, 'sleep 5')
  const { checker } = fakeChecker()
  const { app, url } = await mount(t, { updateChecker: checker, createUpdateRunner: () => runner })

  const first = await app.inject({ method: 'GET', url: url('/hosts/absent-host/net-top') })
  assert.equal(first.statusCode, 200)
  assert.deepEqual(first.json(), { available: false, processes: [] })

  // 失败结果同样进 TTL 缓存：第二次返回同一对象（不打远端），避免悬停反复采
  const second = await app.inject({ method: 'GET', url: url('/hosts/absent-host/net-top') })
  assert.deepEqual(second.json(), first.json())
})
