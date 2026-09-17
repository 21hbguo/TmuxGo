import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const rootDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-file-ops-'))
process.env.TMUX_WEB_FILE_ROOTS = `workspace=${rootDir}`
const { transferEntry } = await import('./file-ops.js')

async function makeCaseDir(name: string) {
  const dir = path.join(rootDir, name)
  await mkdir(dir)
  return name
}

test('transferEntry copy auto-renames conflicts to "name copy"', async () => {
  const caseDir = await makeCaseDir('case-copy')
  await writeFile(path.join(rootDir, caseDir, 'a.txt'), 'hello')
  const first = await transferEntry('root-0', `${caseDir}/a.txt`, 'root-0', caseDir, false)
  assert.equal(first.item.name, 'a copy.txt')
  const second = await transferEntry('root-0', `${caseDir}/a.txt`, 'root-0', caseDir, false)
  assert.equal(second.item.name, 'a copy 2.txt')
})

test('transferEntry copy keeps extensionless and dotfile names sane', async () => {
  const caseDir = await makeCaseDir('case-names')
  await writeFile(path.join(rootDir, caseDir, 'README'), 'x')
  const copied = await transferEntry('root-0', `${caseDir}/README`, 'root-0', caseDir, false)
  assert.equal(copied.item.name, 'README copy')
  await writeFile(path.join(rootDir, caseDir, '.env'), 'x')
  const dotfile = await transferEntry('root-0', `${caseDir}/.env`, 'root-0', caseDir, false)
  assert.equal(dotfile.item.name, '.env copy')
})

test('transferEntry copy renames directories on conflict', async () => {
  const caseDir = await makeCaseDir('case-dir')
  await mkdir(path.join(rootDir, caseDir, 'src'))
  await writeFile(path.join(rootDir, caseDir, 'src', 'x.txt'), 'x')
  const copied = await transferEntry('root-0', `${caseDir}/src`, 'root-0', caseDir, false)
  assert.equal(copied.item.name, 'src copy')
  assert.equal(copied.item.type, 'directory')
})

test('transferEntry move auto-renames on conflict', async () => {
  const caseDir = await makeCaseDir('case-move')
  await mkdir(path.join(rootDir, caseDir, 'dst'))
  await writeFile(path.join(rootDir, caseDir, 'a.txt'), 'one')
  await writeFile(path.join(rootDir, caseDir, 'dst', 'a.txt'), 'two')
  const moved = await transferEntry('root-0', `${caseDir}/a.txt`, 'root-0', `${caseDir}/dst`, true)
  assert.equal(moved.item.name, 'a copy.txt')
})
