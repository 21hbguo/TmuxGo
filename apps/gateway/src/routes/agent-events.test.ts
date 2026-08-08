import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { agentEventRoutes } from './agent-events.js'

test('protects HTTP Agent events and accepts event or payload once', async (t) => {
  const previousToken = process.env.TMUXGO_AGENT_EVENT_TOKEN
  process.env.TMUXGO_AGENT_EVENT_TOKEN = 'agent-event-secret'
  t.after(() => {
    if (previousToken === undefined) delete process.env.TMUXGO_AGENT_EVENT_TOKEN
    else process.env.TMUXGO_AGENT_EVENT_TOKEN = previousToken
  })
  const fastify = Fastify()
  await fastify.register(agentEventRoutes)
  const body = { hostId: 'local', provider: 'opencode', paneId: 'local:%1', sessionName: 'dev', payload: { type: 'busy', eventId: 'busy-1' } }
  const missingToken = await fastify.inject({ method: 'POST', url: '/agent-events', payload: body })
  assert.equal(missingToken.statusCode, 401)
  const wrongToken = await fastify.inject({ method: 'POST', url: '/agent-events', headers: { authorization: 'Bearer wrong' }, payload: body })
  assert.equal(wrongToken.statusCode, 401)
  const accepted = await fastify.inject({ method: 'POST', url: '/agent-events', headers: { authorization: 'Bearer agent-event-secret' }, payload: body })
  assert.equal(accepted.statusCode, 200)
  const acceptedBody = accepted.json() as { accepted: boolean; eventId: string }
  assert.equal(acceptedBody.accepted, true)
  const duplicate = await fastify.inject({ method: 'POST', url: '/agent-events', headers: { 'x-tmuxgo-agent-token': 'agent-event-secret' }, payload: body })
  assert.equal(duplicate.statusCode, 200)
  assert.equal((duplicate.json() as { eventId: string }).eventId, acceptedBody.eventId)
  const both = await fastify.inject({ method: 'POST', url: '/agent-events', headers: { 'x-tmuxgo-agent-token': 'agent-event-secret' }, payload: { ...body, event: { type: 'busy' } } })
  assert.equal(both.statusCode, 400)
  const foreignPane = await fastify.inject({ method: 'POST', url: '/agent-events', headers: { 'x-tmuxgo-agent-token': 'agent-event-secret' }, payload: { ...body, paneId: 'other:%1' } })
  assert.equal(foreignPane.statusCode, 400)
  await fastify.close()
})
