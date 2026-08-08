import assert from 'node:assert/strict'
import test from 'node:test'
import { findChildProcessAgents, parseOsc133Events, parseProcessTree } from './agent-signals.js'
import { detectProcessAgent } from './agent-state.js'
import { parseTmuxAgentHookEvent, tmuxAgentHookMarker } from './tmux-hooks.js'

test('parses OSC 133 prompt, command, output, and exit events', () => {
  assert.deepEqual(parseOsc133Events('\u001b]133;A\u001b\\x\u001b]133;B\u0007run\u001b]133;C\u0007\u001b]133;D;7\u0007'), [
    { type: 'prompt' },
    { type: 'command_started' },
    { type: 'output_started' },
    { type: 'command_finished', status: 7 },
  ])
})
test('finds nested Agent processes from Linux and macOS compatible ps output', () => {
  const output = ['100 1 tmux: pane', '110 100 /bin/zsh', '120 110 node /opt/codex --flag', '130 100 /bin/bash', '140 130 /usr/local/bin/claude'].join('\n')
  assert.deepEqual(parseProcessTree(output).map((entry) => entry.pid), ['100', '110', '120', '130', '140'])
  assert.deepEqual(findChildProcessAgents(output, ['100'], detectProcessAgent), new Map([['100', 'claude']]))
})
test('parses only marked tmux hook events', () => {
  assert.deepEqual(parseTmuxAgentHookEvent(`${tmuxAgentHookMarker}|%3|dev|pane-command-finished||4`), { paneId: '%3', sessionName: 'dev', event: 'pane-command-finished', deadStatus: '', commandStatus: '4' })
  assert.equal(parseTmuxAgentHookEvent('other|%3|dev|pane-exited'), null)
  assert.equal(parseTmuxAgentHookEvent(`${tmuxAgentHookMarker}|bad|dev|pane-exited`), null)
})
