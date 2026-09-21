import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import test from 'node:test'
import { appendSshConfigHost, listSshConfigHosts, readSshConfigText, writeSshConfigText } from './ssh-config.js'

async function withTempDir(t: test.TestContext, fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-sshconfig-'))
  const previous = process.env.TMUXGO_SSH_CONFIG
  t.after(async () => {
    if (previous === undefined) delete process.env.TMUXGO_SSH_CONFIG
    else process.env.TMUXGO_SSH_CONFIG = previous
    await rm(dir, { recursive: true, force: true })
  })
  await fn(dir)
}

test('parses Host blocks with aliases, key=value, quotes and comments', async (t) => {
  await withTempDir(t, async (dir) => {
    const configPath = path.join(dir, 'config')
    await writeFile(
      configPath,
      `# comment line
Host web
  HostName=web.example.com
  User deploy
  Port 2222
  IdentityFile "~/.ssh/id_ed25519 web"
  ProxyJump bastion

Host db db-alt
    HostName db.internal
    User=ops

# another comment
Host *
  ServerAliveInterval 30
`,
    )
    const hosts = await listSshConfigHosts(configPath)
    assert.equal(hosts.length, 3)
    const web = hosts.find((h) => h.alias === 'web')!
    assert.equal(web.hostName, 'web.example.com')
    assert.equal(web.user, 'deploy')
    assert.equal(web.port, 2222)
    assert.equal(web.identityFile, '~/.ssh/id_ed25519 web')
    assert.equal(web.proxyJump, 'bastion')
    assert.equal(web.sourceFile, configPath)
    assert.equal(web.line, 2)
    const db = hosts.find((h) => h.alias === 'db')!
    const dbAlt = hosts.find((h) => h.alias === 'db-alt')!
    assert.equal(db.hostName, 'db.internal')
    assert.equal(dbAlt.user, 'ops')
    // Host * 通配块不可列出
    assert.ok(!hosts.some((h) => h.alias === '*'))
  })
})

test('applies first-value-wins for duplicate keys and duplicate Host blocks', async (t) => {
  await withTempDir(t, async (dir) => {
    const configPath = path.join(dir, 'config')
    await writeFile(
      configPath,
      `Host dup
  User first
  User second
  HostName one.example

Host dup
  HostName two.example
  Port 2200
`,
    )
    const [dup] = await listSshConfigHosts(configPath)
    assert.equal(dup.user, 'first')
    assert.equal(dup.hostName, 'one.example')
    assert.equal(dup.port, 2200)
    assert.equal(dup.line, 1)
  })
})

test('skips negated patterns, wildcard aliases and Match blocks', async (t) => {
  await withTempDir(t, async (dir) => {
    const configPath = path.join(dir, 'config')
    await writeFile(
      configPath,
      `Host *.corp !bastion.corp good
  User corpuser

Match user admin
  ForwardAgent yes

Host after
  HostName after.example
`,
    )
    const hosts = await listSshConfigHosts(configPath)
    assert.deepEqual(hosts.map((h) => h.alias).sort(), ['after', 'good'])
    assert.equal(hosts.find((h) => h.alias === 'good')?.user, 'corpuser')
    assert.equal(hosts.find((h) => h.alias === 'after')?.forwardAgent, '')
  })
})

test('follows Include with glob, tilde expansion and cycle protection', async (t) => {
  await withTempDir(t, async (dir) => {
    const confd = path.join(dir, 'conf.d')
    await mkdir(confd)
    const configPath = path.join(dir, 'config')
    const loopPath = path.join(confd, 'loop.conf')
    await writeFile(
      path.join(confd, 'b.conf'),
      `Host included
  HostName inc.example
  User incuser
`,
    )
    await writeFile(loopPath, `Include ${configPath}\nHost looped\n  HostName loop.example\n`)
    await writeFile(
      configPath,
      `Include conf.d/*.conf
Host main
  HostName main.example
`,
    )
    const hosts = await listSshConfigHosts(configPath)
    assert.deepEqual(hosts.map((h) => h.alias).sort(), ['included', 'looped', 'main'])
    assert.equal(hosts.find((h) => h.alias === 'included')?.sourceFile, path.join(confd, 'b.conf'))
  })
})

test('appends a Host block with validation and rejects duplicates/injection', async (t) => {
  await withTempDir(t, async (dir) => {
    const configPath = path.join(dir, 'config')
    process.env.TMUXGO_SSH_CONFIG = configPath
    const result = await appendSshConfigHost({
      alias: 'box',
      hostName: '10.0.0.8',
      user: 'guo',
      port: 2222,
      identityFile: '~/.ssh/id_box',
    })
    assert.equal(result.path, configPath)
    const content = (await readSshConfigText(configPath)).content
    assert.match(
      content,
      /Host box\n {2}HostName 10\.0\.0\.8\n {2}User guo\n {2}Port 2222\n {2}IdentityFile ~\/.ssh\/id_box\n/,
    )
    assert.equal((await stat(configPath)).mode & 0o777, 0o600)
    await assert.rejects(appendSshConfigHost({ alias: 'box', hostName: 'x' }), /already exists/)
    await assert.rejects(appendSshConfigHost({ alias: 'evil\nHost x', hostName: 'x' }), /Invalid/)
    await assert.rejects(appendSshConfigHost({ alias: 'ok2', hostName: 'h\n  User root' }), /Invalid/)
    await assert.rejects(appendSshConfigHost({ alias: 'bad*', hostName: 'x' }), /Invalid host alias/)
    await assert.rejects(appendSshConfigHost({ alias: 'local', hostName: 'x' }), /Invalid host alias/)
    await assert.rejects(appendSshConfigHost({ alias: 'p', hostName: 'x', port: 70000 }), /Invalid port/)
  })
})

test('writes config text to resolved path only, creating a .bak backup', async (t) => {
  await withTempDir(t, async (dir) => {
    const configPath = path.join(dir, 'config')
    await writeFile(configPath, 'Host old\n  HostName old.example\n')
    process.env.TMUXGO_SSH_CONFIG = configPath
    const result = await writeSshConfigText('Host new\n  HostName new.example\n')
    assert.equal(result.path, configPath)
    assert.equal(await readFile(`${configPath}.bak`, 'utf8'), 'Host old\n  HostName old.example\n')
    assert.equal(await readFile(configPath, 'utf8'), 'Host new\n  HostName new.example\n')
  })
})

test('merges ssh config entries with hosts.json overlay and keeps store-only hosts', async (t) => {
  await withTempDir(t, async (dir) => {
    const configPath = path.join(dir, 'sshconfig')
    const configDir = path.join(dir, 'cfg')
    await mkdir(configDir)
    await writeFile(
      configPath,
      `Host hlsj
  HostName 100.73.105.110
  User hhl
  IdentityFile ~/.ssh/id_ed25519_hlsj
  ForwardAgent yes

Host plain
  HostName 192.168.1.2
`,
    )
    process.env.TMUXGO_SSH_CONFIG = configPath
    const previousConfigDir = process.env.TMUXGO_CONFIG_DIR
    process.env.TMUXGO_CONFIG_DIR = configDir
    t.after(() => {
      if (previousConfigDir === undefined) delete process.env.TMUXGO_CONFIG_DIR
      else process.env.TMUXGO_CONFIG_DIR = previousConfigDir
    })
    const hosts = await import(`./hosts.js?merge-test=${Date.now()}-${Math.random()}`)
    await hosts.upsertRemoteHost({
      id: 'hlsj',
      name: 'HL SJ',
      address: 'stale.example',
      user: 'stale',
      port: 1,
      favorite: true,
      groups: ['prod'],
      tmuxPath: '/opt/tmux',
    })
    await hosts.upsertRemoteHost({ id: 'manual', name: 'Manual', address: 'manual.example', user: 'me', port: 2022 })
    const all = await hosts.listAllHosts()
    const hlsj = all.find((h: any) => h.id === 'hlsj')!
    assert.equal(hlsj.source, 'sshconfig')
    assert.equal(hlsj.address, '100.73.105.110')
    assert.equal(hlsj.user, 'hhl')
    assert.equal(hlsj.port, 22)
    assert.equal(hlsj.identityFile, '~/.ssh/id_ed25519_hlsj')
    assert.equal(hlsj.name, 'HL SJ')
    assert.equal(hlsj.favorite, true)
    assert.deepEqual(hlsj.groups, ['prod'])
    assert.equal(hlsj.tmuxPath, '/opt/tmux')
    assert.equal(hlsj.useAgent, true)
    const manual = all.find((h: any) => h.id === 'manual')!
    assert.equal(manual.source, 'store')
    assert.equal(manual.port, 2022)
    const plain = all.find((h: any) => h.id === 'plain')!
    assert.equal(plain.source, 'sshconfig')
    assert.equal(plain.name, 'plain')
    assert.equal(plain.user, '')
    assert.equal((await hosts.getHostById('hlsj'))?.source, 'sshconfig')
    assert.equal((await hosts.getHostById('local'))?.source, 'local')
  })
})
