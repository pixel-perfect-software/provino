// T7.15's drift report on trees written here: no tarball is fetched.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { parseDriftArgs } from './cli.ts'
import { driftBetween, driftFails, formatDrift } from './drift.ts'
import { parseUpstream } from './upstream.ts'

const UPSTREAM = `# Vendored upstream

- **Repository:** https://github.com/jestjs/jest (MIT)

| File here | Source (\`packages/expect/src/\`) | How |
|---|---|---|
| \`matchers.ts\` | \`matchers.ts\` | copied |
| \`print.ts\` | \`print.ts\` L1-L9 | extracted |
| \`own.ts\` | none | Provino's own |
| \`circus.ts\` | \`packages/jest-circus/src/format.ts\` (v30.5.2) | copied |
| \`gone.ts\` | \`gone.ts\` | copied |

| Other | Not a source |
|---|---|
| \`not-a-source.ts\` | x |
`

const root = mkdtempSync(join(tmpdir(), 'provino-drift-test-'))
after(() => rmSync(root, { recursive: true, force: true }))

function tree(name: string, files: Record<string, string>): string {
  const dir = join(root, name)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}

describe('parseUpstream', () => {
  test('the repository and the source column, under its base', () => {
    const parsed = parseUpstream('x/UPSTREAM.md', UPSTREAM)
    assert.deepEqual(parsed.repositories, ['jest'])
    assert.deepEqual(
      parsed.sources.map((source) => source.paths),
      [
        ['packages/expect/src/matchers.ts', 'matchers.ts', 'packages/matchers.ts'],
        ['packages/expect/src/print.ts', 'print.ts', 'packages/print.ts'],
        [
          'packages/expect/src/packages/jest-circus/src/format.ts',
          'packages/jest-circus/src/format.ts',
        ],
        ['packages/expect/src/gone.ts', 'gone.ts', 'packages/gone.ts'],
      ],
    )
    assert.deepEqual(new Set(parsed.sources.map((source) => source.repository)), new Set(['jest']))
  })
})

describe('driftBetween', () => {
  const from = tree('from', {
    'packages/expect/src/matchers.ts': 'a',
    'packages/expect/src/print.ts': 'same',
    'packages/jest-circus/src/format.ts': 'old',
    'packages/expect/src/index.ts': 'not vendored',
  })
  const to = tree('to', {
    'packages/expect/src/matchers.ts': 'b',
    'packages/expect/src/print.ts': 'same',
    'packages/expect/src/index.ts': 'not vendored, changed',
  })
  const report = driftBetween('jest', { from: 'v1', to: 'v2' }, { from, to }, [
    parseUpstream('x/UPSTREAM.md', UPSTREAM),
  ])

  test('names each copied file that differs, with the UPSTREAM.md that copied it', () => {
    assert.equal(report.checked, 3)
    assert.deepEqual(report.drifted, [
      { path: 'packages/expect/src/matchers.ts', change: 'changed', upstreams: ['x/UPSTREAM.md'] },
      {
        path: 'packages/jest-circus/src/format.ts',
        change: 'removed',
        upstreams: ['x/UPSTREAM.md'],
      },
    ])
    assert.deepEqual(report.unresolved, [
      { upstream: 'x/UPSTREAM.md', source: 'packages/expect/src/gone.ts' },
    ])
  })

  test('an UPSTREAM.md of another repository is not read', () => {
    const none = driftBetween('vitest', { from: 'v1', to: 'v2' }, { from, to }, [
      parseUpstream('x/UPSTREAM.md', UPSTREAM),
    ])
    assert.deepEqual({ checked: none.checked, drifted: none.drifted }, { checked: 0, drifted: [] })
  })

  test('the printed report', () => {
    assert.equal(
      formatDrift(report),
      [
        'jest v1..v2: 2 of 3 vendored files differ',
        '  changed  packages/expect/src/matchers.ts',
        '           copied by x/UPSTREAM.md',
        '  removed  packages/jest-circus/src/format.ts',
        '           copied by x/UPSTREAM.md',
        '  unresolved packages/expect/src/gone.ts (x/UPSTREAM.md): in neither tag',
      ].join('\n'),
    )
  })
})

const TWO = `# Vendored upstream

- **Repository:** https://github.com/vitest-dev/vitest (MIT)

| File here | Source (\`packages/expect/src/\`) |
|---|---|
| \`own.ts\` | \`own.ts\` |
| \`stale.ts\` | \`stale.ts\` |

- **Also:** https://github.com/jestjs/jest (MIT)

| File here | Source |
|---|---|
| \`diff.ts\` | \`packages/diff-sequences/src/index.ts\` |
| \`lost.ts\` | \`packages/lost/src/index.ts\` |
`

describe('an UPSTREAM.md that names two repositories', () => {
  const upstream = parseUpstream('two/UPSTREAM.md', TWO)
  const vitestTree = tree('two-vitest', { 'packages/expect/src/own.ts': 'v' })
  const jestTree = tree('two-jest', { 'packages/diff-sequences/src/index.ts': 'j' })

  test('each source goes to the repository whose URL is nearest it', () => {
    assert.deepEqual(
      upstream.sources.map((source) => [source.paths.at(-1), source.repository]),
      [
        ['packages/own.ts', 'vitest'],
        ['packages/stale.ts', 'vitest'],
        ['packages/diff-sequences/src/index.ts', 'jest'],
        ['packages/lost/src/index.ts', 'jest'],
      ],
    )
  })

  test('a source in neither tree is unresolved in its own repository`s report', () => {
    const vitest = driftBetween(
      'vitest',
      { from: 'a', to: 'b' },
      { from: vitestTree, to: vitestTree },
      [upstream],
    )
    const jest = driftBetween('jest', { from: 'a', to: 'b' }, { from: jestTree, to: jestTree }, [
      upstream,
    ])
    assert.deepEqual(vitest.unresolved, [
      { upstream: 'two/UPSTREAM.md', source: 'packages/expect/src/stale.ts' },
    ])
    assert.deepEqual(jest.unresolved, [
      { upstream: 'two/UPSTREAM.md', source: 'packages/lost/src/index.ts' },
    ])
    assert.equal(vitest.checked, 1)
    assert.equal(jest.checked, 1)
    assert.equal(driftFails(vitest), true)
    assert.equal(driftFails(jest), true)
  })
})

describe('driftFails', () => {
  const report = { repository: 'jest', from: 'a', to: 'b', drifted: [] } as const
  test('an unresolved source or nothing checked fails; a clean report does not', () => {
    assert.equal(driftFails({ ...report, checked: 2, unresolved: [] }), false)
    assert.equal(driftFails({ ...report, checked: 0, unresolved: [] }), true)
    assert.equal(
      driftFails({ ...report, checked: 2, unresolved: [{ upstream: 'u', source: 's' }] }),
      true,
    )
  })
})

describe('parseDriftArgs', () => {
  test('one range per repository flag', () => {
    assert.deepEqual(parseDriftArgs(['--jest', 'v30.5.1..v30.5.2', '--vitest', 'v5.0.4..v5.0.5']), [
      { repository: 'jest', from: 'v30.5.1', to: 'v30.5.2' },
      { repository: 'vitest', from: 'v5.0.4', to: 'v5.0.5' },
    ])
  })

  test('usage errors', () => {
    assert.equal(parseDriftArgs([]), 'name at least one range')
    assert.equal(parseDriftArgs(['--mocha', 'a..b']), 'unknown argument --mocha')
    assert.equal(parseDriftArgs(['--jest', 'v1']), '--jest needs <from>..<to>')
  })
})
