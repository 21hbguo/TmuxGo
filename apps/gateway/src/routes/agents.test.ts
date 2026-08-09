import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { ZodError } from 'zod'
import type { WebSocket } from 'ws'
import { AgentManager } from '../agent-manager.js'
import { agentRoutes } from './agents.js'

test('removeAgent removes an online Agent and its history', () => {
  const manager = new AgentManager({ historyPath: null })
  const id = `agent-${Date.now()}-${Math.random()}`
  const socket = { readyState: 1, send: () => {} } as unknown as WebSocket
  manager.register(id, 'agent', '127.0.0.1', '1.0.0', socket)
  assert.equal(manager.getAgentStatus(id)?.online, true)
  assert.equal(manager.removeAgent(id), true)
  assert.equal(manager.getAgent(id), undefined)
  assert.equal(manager.getAgentStatus(id), undefined)
  assert.equal(manager.removeAgent(id), false)
})

test('removeAgent removes an offline Agent history entry', () => {
  const manager = new AgentManager({ historyPath: null })
  const id = `agent-${Date.now()}-${Math.random()}`
  const socket = { readyState: 1, send: () => {} } as unknown as WebSocket
  manager.register(id, 'agent', '127.0.0.1', '1.0.0', socket)
  assert.equal(manager.unregister(id, socket), true)
  assert.equal(manager.getAgentStatus(id)?.online, false)
  assert.equal(manager.removeAgent(id), true)
  assert.equal(manager.getAgentStatus(id), undefined)
})

test('DELETE /agents/:id removes an Agent and reports success:false for a missing one', async () => {
  const manager = new AgentManager({ historyPath: null })
  const id = `agent-${Date.now()}-${Math.random()}`
  const socket = { readyState: 1, send: () => {} } as unknown as WebSocket
  const fastify = Fastify()
  fastify.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ message: error.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; '), code: 'INVALID_REQUEST' })
    return reply.send(error as Error)
  })
  await fastify.register(agentRoutes, { agentManager: manager })
  manager.register(id, 'agent', '127.0.0.1', '1.0.0', socket)
  const removed = await fastify.inject({ method: 'DELETE', url: `/agents/${id}` })
  assert.equal(removed.statusCode, 200)
  assert.deepEqual(removed.json(), { success: true })
  assert.equal(manager.getAgentStatus(id), undefined)
  const missing = await fastify.inject({ method: 'DELETE', url: `/agents/${id}` })
  assert.equal(missing.statusCode, 200)
  assert.deepEqual(missing.json(), { success: false })
  const invalid = await fastify.inject({ method: 'DELETE', url: '/agents/bad%20id' })
  assert.equal(invalid.statusCode, 400)
  await fastify.close()
})
