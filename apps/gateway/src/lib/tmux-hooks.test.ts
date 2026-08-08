import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTmuxAgentHookEvent, parseTmuxAgentHookEvents } from './tmux-hooks.js'

test('parses current tab hook records with optional lifecycle session', () => {
  assert.deepEqual(parseTmuxAgentHookEvent('tmuxgo-agent-monitor:v2\t%1\tdev\tpane-command-finished\t\t0'), { paneId: '%1', sessionName: 'dev', event: 'pane-command-finished', deadStatus: '', commandStatus: '0' })
  assert.deepEqual(parseTmuxAgentHookEvent('tmuxgo-agent-monitor:v2\t%1\tpane-exited\t0\t'), { paneId: '%1', event: 'pane-exited', deadStatus: '0', commandStatus: '' })
})
test('keeps compatibility with legacy pipe records and consumes multiple events', () => {
  const value = 'tmuxgo-agent-monitor:v1|%2|dev|pane-died|1|1\ntmuxgo-agent-monitor:v2\t%3\tdev\tpane-command-started\t\t'
  assert.equal(parseTmuxAgentHookEvents(value).length, 2)
  assert.equal(parseTmuxAgentHookEvents(value)[0]?.event, 'pane-died')
})
