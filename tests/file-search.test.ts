import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'

async function createSearchApp(rootDir: string) {
  process.env.TMUX_WEB_FILE_ROOTS = `workspace=${rootDir}`
  const { fileRoutes } = await import('../apps/gateway/src/routes/files')
  const app = Fastify()
  await app.register(fileRoutes, { prefix: '/api' })
  return app
}

test('search routes exclude dotfiles when includeDotFiles is false', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-file-search-'))
  const searchDir = path.join(rootDir, 'search')
  const hiddenDir = path.join(searchDir, '.hidden')
  await mkdir(hiddenDir, { recursive: true })
  await writeFile(path.join(hiddenDir, 'tmuxgo-hidden.md'), 'tmuxgo hidden content')
  await writeFile(path.join(searchDir, 'tmuxgo-visible.md'), 'tmuxgo visible content')
  const app = await createSearchApp(rootDir)
  t.after(async () => {
    await app.close()
    delete process.env.TMUX_WEB_FILE_ROOTS
    await rm(rootDir, { recursive: true, force: true })
  })
  const nameResponse = await app.inject({
    method: 'GET',
    url: '/api/hosts/local/files/search-name',
    query: {
      root: 'root-0',
      q: 'tmuxgo',
      basePath: 'search',
      includeDotFiles: 'false',
    },
  })
  assert.equal(nameResponse.statusCode, 200)
  assert.deepEqual(nameResponse.json().map((item: { path: string }) => item.path), ['search/tmuxgo-visible.md'])
  const contentResponse = await app.inject({
    method: 'GET',
    url: '/api/hosts/local/files/search-content',
    query: {
      root: 'root-0',
      q: 'tmuxgo',
      basePath: 'search',
      includeDotFiles: 'false',
    },
  })
  assert.equal(contentResponse.statusCode, 200)
  assert.deepEqual(contentResponse.json().map((item: { path: string }) => item.path), ['search/tmuxgo-visible.md'])
})
