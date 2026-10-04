import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildSessionLayoutDocument,
  normalizeSessionLayoutDocument,
  SESSION_LAYOUT_KIND,
  sessionLayoutToTemplateLayout,
} from './session-layout.js'

test('builds a layout document with inferred split, preset, cwd and filtered commands', () => {
  const doc = buildSessionLayoutDocument({
    sessionName: 'dev',
    hostId: 'local',
    exportedAt: '2026-10-04T00:00:00.000Z',
    windows: [
      {
        name: 'editor',
        panes: [
          { index: 0, cwd: '/repo', command: 'nvim', left: 0, top: 0, width: 80, height: 24 },
          { index: 1, cwd: '/repo', command: 'zsh', left: 80, top: 0, width: 80, height: 24 },
        ],
      },
      {
        name: 'logs',
        panes: [
          { index: 0, cwd: '/var/log', command: 'tail', left: 0, top: 0, width: 160, height: 12 },
          { index: 1, cwd: '/var/log', command: 'htop', left: 0, top: 12, width: 160, height: 12 },
        ],
      },
    ],
  })
  assert.equal(doc.kind, SESSION_LAYOUT_KIND)
  assert.equal(doc.version, 1)
  assert.equal(doc.name, 'dev')
  assert.equal(doc.sourceHostId, 'local')
  assert.equal(doc.windows[0].name, 'editor')
  assert.equal(doc.windows[0].splitDirection, 'horizontal')
  assert.equal(doc.windows[0].layoutPreset, 'even-horizontal')
  assert.deepEqual(doc.windows[0].panes, [{ command: 'nvim', cwd: '/repo' }, { cwd: '/repo' }])
  assert.equal(doc.windows[1].splitDirection, 'vertical')
  assert.equal(doc.windows[1].layoutPreset, 'even-vertical')
  assert.deepEqual(doc.windows[1].panes, [
    { command: 'tail', cwd: '/var/log' },
    { command: 'htop', cwd: '/var/log' },
  ])
  assert.equal(JSON.stringify(doc).includes('TOKEN'), false)
})
test('keeps pane order by index and tolerates missing geometry', () => {
  const doc = buildSessionLayoutDocument({
    sessionName: 's',
    windows: [
      {
        name: '',
        panes: [
          { index: 2, cwd: '/b', command: 'vim' },
          { index: 0, cwd: '/a', command: 'top' },
        ],
      },
    ],
  })
  assert.equal(doc.windows[0].name, 'win-1')
  assert.equal(doc.windows[0].splitDirection, 'horizontal')
  assert.equal(doc.windows[0].layoutPreset, 'tiled')
  assert.deepEqual(
    doc.windows[0].panes.map((pane) => pane.cwd),
    ['/a', '/b'],
  )
})
test('normalizes a valid document and fills defaults', () => {
  const doc = normalizeSessionLayoutDocument({
    kind: 'tmuxgo.session-layout',
    version: 1,
    name: 'dev',
    windows: [
      {
        name: 'main',
        panes: [{ command: 'vim', cwd: '/repo', env: { NODE_ENV: 'dev' } }],
        splitDirection: 'vertical',
        layoutPreset: 'main-vertical',
      },
    ],
  })
  assert.equal(doc.name, 'dev')
  assert.equal(doc.windows[0].splitDirection, 'vertical')
  assert.equal(doc.windows[0].layoutPreset, 'main-vertical')
  assert.deepEqual(doc.windows[0].panes, [{ command: 'vim', cwd: '/repo', env: { NODE_ENV: 'dev' } }])
  const bare = normalizeSessionLayoutDocument({ windows: [{ name: 'w', panes: [{}] }] })
  assert.equal(bare.kind, SESSION_LAYOUT_KIND)
  assert.equal(bare.name, 'layout')
})
test('rejects invalid kind, version, window and pane shapes with clear errors', () => {
  assert.throws(() => normalizeSessionLayoutDocument(null), /document must be an object/)
  assert.throws(() => normalizeSessionLayoutDocument({ kind: 'other' }), /unsupported kind/)
  assert.throws(
    () => normalizeSessionLayoutDocument({ version: 2, windows: [{ name: 'w', panes: [{}] }] }),
    /unsupported version/,
  )
  assert.throws(() => normalizeSessionLayoutDocument({ windows: [] }), /non-empty array/)
  assert.throws(
    () =>
      normalizeSessionLayoutDocument({
        windows: Array.from({ length: 9 }, (_, index) => ({ name: `w${index}`, panes: [{}] })),
      }),
    /windows exceeds limit/,
  )
  assert.throws(() => normalizeSessionLayoutDocument({ windows: [{ panes: [{}] }] }), /name is required/)
  assert.throws(() => normalizeSessionLayoutDocument({ windows: [{ name: 'w', panes: [] }] }), /non-empty array/)
  assert.throws(
    () =>
      normalizeSessionLayoutDocument({
        windows: [{ name: 'w', panes: Array.from({ length: 9 }, () => ({})) }],
      }),
    /panes exceeds limit/,
  )
  assert.throws(
    () =>
      normalizeSessionLayoutDocument({
        windows: [{ name: 'w', panes: [{}], splitDirection: 'diagonal' }],
      }),
    /splitDirection/,
  )
  assert.throws(
    () =>
      normalizeSessionLayoutDocument({
        windows: [{ name: 'w', panes: [{}], layoutPreset: 'grid' }],
      }),
    /layoutPreset/,
  )
  assert.throws(
    () =>
      normalizeSessionLayoutDocument({
        windows: [{ name: 'w', panes: [{ env: { 'BAD-KEY': 'x' } }] }],
      }),
    /env key invalid/,
  )
})
test('converts a document to the existing template layout model', () => {
  const doc = normalizeSessionLayoutDocument({
    windows: [{ name: 'w', panes: [{ command: 'vim' }], splitDirection: 'vertical' }],
  })
  const layout = sessionLayoutToTemplateLayout(doc)
  assert.deepEqual(layout, {
    windows: [{ name: 'w', panes: [{ command: 'vim' }], splitDirection: 'vertical', layoutPreset: 'tiled' }],
  })
})
