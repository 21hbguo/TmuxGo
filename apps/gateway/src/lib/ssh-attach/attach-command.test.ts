import '../../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { ATTACH_COMMAND_HELP, parseAttachCommand } from './attach-command.js'
test('parses attach command with default shared mode', () => {
  assert.deepEqual(parseAttachCommand(['attach', '--host', 'devbox', '--session', 'dev']), {
    hostId: 'devbox',
    sessionName: 'dev',
    mode: 'shared',
  })
})
test('parses short options and explicit modes', () => {
  assert.deepEqual(parseAttachCommand(['attach', '-h', 'devbox', '-s', 'dev']), {
    hostId: 'devbox',
    sessionName: 'dev',
    mode: 'shared',
  })
  assert.deepEqual(parseAttachCommand(['attach', '--host', 'devbox', '--session', 'dev', '--readonly']), {
    hostId: 'devbox',
    sessionName: 'dev',
    mode: 'readonly',
  })
  assert.deepEqual(parseAttachCommand(['attach', '--host', 'devbox', '--session', 'dev', '--exclusive']), {
    hostId: 'devbox',
    sessionName: 'dev',
    mode: 'exclusive',
  })
})
test('rejects invalid attach commands', () => {
  assert.throws(() => parseAttachCommand(['list', '--host', 'devbox']), /Unknown command/)
  assert.throws(() => parseAttachCommand(['attach', '--host', 'devbox']), /Missing required option: --session/)
  assert.throws(() => parseAttachCommand(['attach', '--session', 'dev']), /Missing required option: --host/)
  assert.throws(
    () => parseAttachCommand(['attach', '--host', 'devbox', '--session', 'dev', '--shared', '--readonly']),
    /Conflicting mode options/,
  )
  assert.throws(
    () => parseAttachCommand(['attach', '--host', 'devbox', '--session', 'dev', '--unknown']),
    /Unknown option: --unknown/,
  )
  assert.throws(() => parseAttachCommand(['attach', '--host']), /Missing value for option: --host/)
  assert.throws(
    () => parseAttachCommand(['attach', '--host', 'devbox', '--session']),
    /Missing value for option: --session/,
  )
  assert.throws(() => parseAttachCommand(['attach', '--host', 'bad host', '--session', 'dev']), /Invalid host id/)
  assert.throws(
    () => parseAttachCommand(['attach', '--host', 'devbox', '--session', 'bad session']),
    /Invalid session name/,
  )
})
test('describes attach usage in help text', () => {
  assert.match(ATTACH_COMMAND_HELP, /attach --host <host> --session <name> \[--shared\|--exclusive\|--readonly\]/)
})
