import test from 'node:test'
import assert from 'node:assert/strict'
import { HostCooldownError, probeWithCooldown, resetHostProbeCooldowns } from './host-probe-cooldown.js'

test('probe failure enters cooldown and short-circuits the next call with the same message', async () => {
  resetHostProbeCooldowns()
  let calls = 0
  const probe = async () => {
    calls += 1
    throw new Error('SSH connection timed out')
  }
  await assert.rejects(probeWithCooldown('h1', probe), { message: 'SSH connection timed out' })
  assert.equal(calls, 1)
  // 冷却窗内：不再触探，直接抛缓存的同构错误（type 变了但 message 不变，上层语义一致）
  const second = await probeWithCooldown('h1', probe).then(
    () => null,
    (error: unknown) => error,
  )
  assert.ok(second instanceof HostCooldownError)
  assert.equal(second.message, 'SSH connection timed out')
  assert.equal(calls, 1)
})

test('cooldown is per-host and cleared on success / after expiry', async () => {
  resetHostProbeCooldowns()
  const failing = async () => {
    throw new Error('SSH authentication failed')
  }
  await assert.rejects(probeWithCooldown('h1', failing))
  // 别的 host 不受 h1 冷却影响
  const ok = await probeWithCooldown('h2', async () => 'fine')
  assert.equal(ok, 'fine')
  // 极短冷却窗口 → 到期重新探测，成功后清除
  await assert.rejects(probeWithCooldown('h3', failing, 1))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const recovered = await probeWithCooldown('h3', async () => 'back')
  assert.equal(recovered, 'back')
  assert.equal(await probeWithCooldown('h3', async () => 'still back'), 'still back')
})
