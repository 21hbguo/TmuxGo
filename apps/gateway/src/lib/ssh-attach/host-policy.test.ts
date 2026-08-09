import assert from 'node:assert/strict'
import test from 'node:test'
async function loadHostPolicy() {
  return import(`./host-policy.js?test=${Date.now()}-${Math.random()}`)
}
test('allows all hosts when TMUXGO_SSH_ALLOWED_HOSTS is unset or empty', async () => {
  delete process.env.TMUXGO_SSH_ALLOWED_HOSTS
  const unset = await loadHostPolicy()
  assert.equal(unset.isSshHostAllowed('alice', 'hlsj'), true)
  assert.doesNotThrow(() => unset.assertSshHostAllowed('alice', 'hlsj'))
  process.env.TMUXGO_SSH_ALLOWED_HOSTS = ''
  const empty = await loadHostPolicy()
  assert.equal(empty.isSshHostAllowed('alice', 'hlsj'), true)
  delete process.env.TMUXGO_SSH_ALLOWED_HOSTS
})
test('restricts hosts listed in TMUXGO_SSH_ALLOWED_HOSTS', async () => {
  process.env.TMUXGO_SSH_ALLOWED_HOSTS = 'hlsj,remote'
  const policy = await loadHostPolicy()
  assert.equal(policy.isSshHostAllowed('alice', 'hlsj'), true)
  assert.equal(policy.isSshHostAllowed('alice', 'remote'), true)
  assert.equal(policy.isSshHostAllowed('alice', 'other'), false)
  assert.throws(() => policy.assertSshHostAllowed('alice', 'other'), /Host is not allowed for SSH user/)
  delete process.env.TMUXGO_SSH_ALLOWED_HOSTS
})
test('allows per-user host entries like alice@hlsj', async () => {
  process.env.TMUXGO_SSH_ALLOWED_HOSTS = 'alice@hlsj'
  const policy = await loadHostPolicy()
  assert.equal(policy.isSshHostAllowed('alice', 'hlsj'), true)
  assert.equal(policy.isSshHostAllowed('bob', 'hlsj'), false)
  assert.equal(policy.isSshHostAllowed('bob', 'other'), false)
  assert.throws(() => policy.assertSshHostAllowed('bob', 'hlsj'), /Host is not allowed for SSH user/)
  delete process.env.TMUXGO_SSH_ALLOWED_HOSTS
})
