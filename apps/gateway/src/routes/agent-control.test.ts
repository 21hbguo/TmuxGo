import '../test-env.js'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { agentControlRoutes } from './agent-control.js'

test('protects control routes with token and TMUXGO_ENV guard', async (t) => {
  const previousToken = process.env.TMUXGO_AGENT_EVENT_TOKEN
  process.env.TMUXGO_AGENT_EVENT_TOKEN = 'agent-control-secret'
  t.after(() => {
    if (previousToken === undefined) delete process.env.TMUXGO_AGENT_EVENT_TOKEN
    else process.env.TMUXGO_AGENT_EVENT_TOKEN = previousToken
  })
  const fastify = Fastify()
  await fastify.register(agentControlRoutes)
  const body = { paneId: 'local:%1', direction: 'horizontal' }
  const missingToken = await fastify.inject({ method: 'POST', url: '/v1/control/panes/split', payload: body })
  assert.equal(missingToken.statusCode, 401)
  const noGuard = await fastify.inject({
    method: 'POST',
    url: '/v1/control/panes/split',
    headers: { 'x-tmuxgo-agent-token': 'agent-control-secret' },
    payload: body,
  })
  assert.equal(noGuard.statusCode, 403)
  const invalidWait = await fastify.inject({
    method: 'POST',
    url: '/v1/control/agent/wait',
    headers: { 'x-tmuxgo-agent-token': 'agent-control-secret', 'x-tmuxgo-env': '1' },
    payload: { target: { paneId: 'local:%1' }, condition: {} },
  })
  assert.equal(invalidWait.statusCode, 400)
  await fastify.close()
})
