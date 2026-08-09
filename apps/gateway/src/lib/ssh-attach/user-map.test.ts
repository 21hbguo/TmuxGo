import assert from 'node:assert/strict'
import test from 'node:test'
async function loadUserMap() {
  return import(`./user-map.js?test=${Date.now()}-${Math.random()}`)
}
test('maps ssh users from TMUXGO_SSH_USER_MAP', async () => {
  process.env.TMUXGO_SSH_USER_MAP = 'alice=tmuxAlice,bob=tmuxBob, carol = tmuxCarol '
  const userMap = await loadUserMap()
  assert.equal(userMap.resolveSshUser('alice'), 'tmuxAlice')
  assert.equal(userMap.resolveSshUser('bob'), 'tmuxBob')
  assert.equal(userMap.resolveSshUser('carol'), 'tmuxCarol')
  assert.equal(userMap.resolveSshUser('unknown'), 'unknown')
  delete process.env.TMUXGO_SSH_USER_MAP
})
test('returns the ssh user when no mapping is configured', async () => {
  delete process.env.TMUXGO_SSH_USER_MAP
  const userMap = await loadUserMap()
  assert.equal(userMap.resolveSshUser('alice'), 'alice')
})
