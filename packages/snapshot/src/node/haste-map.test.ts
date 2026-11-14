// The obsolete-file crawl against Jest 30.5.2's own haste map (B23d B1 review, finding 4): the
// edges no test run shows (a root with `node_modules` above it finds no test file, so Jest never
// reaches its cleanup) read off `Runtime.createHasteMap` over a config Jest normalized, built, and
// asked for the `.snap` files as `cleanup` asks (`matchFiles('\.snap$')`). Jest comes from the
// harness's install, as `packages/provino/test/live-jest.ts` finds it.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { cleanObsoleteSnapshotFiles } from './obsolete-files.ts'

const harness = createRequire(new URL('../../../harness/package.json', import.meta.url))
const jestRequire = createRequire(harness.resolve('jest/package.json'))
const configRequire = createRequire(
  createRequire(jestRequire.resolve('jest-cli/package.json')).resolve('jest-config/package.json'),
)
const { normalize } = configRequire('jest-config') as {
  normalize(
    options: Record<string, unknown>,
    argv: Record<string, unknown>,
  ): Promise<{ options: object }>
}
const Runtime = (
  createRequire(configRequire.resolve('jest-runtime/package.json'))('jest-runtime') as {
    default: {
      createHasteMap(
        config: object,
        options: { watchman: boolean },
      ): Promise<{
        build(): Promise<{ hasteFS: { matchFiles(pattern: string): string[] } }>
      }>
    }
  }
).default

/** The `.snap` files Jest's haste map has for `config`, sorted. */
async function hasteSnapFiles(config: Record<string, unknown>): Promise<string[]> {
  const { options } = await normalize(config, {})
  const map = await Runtime.createHasteMap(options, { watchman: false })
  const { hasteFS } = await map.build()
  return hasteFS.matchFiles('\\.snap$').sort()
}

/** The `.snap` files the cleanup's crawl finds in `roots`, sorted. */
function crawledSnapFiles(roots: readonly string[], ignorePatterns: readonly string[]): string[] {
  return cleanObsoleteSnapshotFiles({
    roots,
    extension: '.snap',
    crawlIgnorePatterns: ignorePatterns,
    testPathIgnorePatterns: [],
    // No snapshot file has a test file, so every one the crawl sees is reported.
    testPathOf: (path) => `${path}.no-such-test-file`,
    update: 'new',
  })
}

function tree(files: readonly string[]): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-haste-')))
  after(() => rmSync(root, { recursive: true, force: true }))
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), '')
  }
  return root
}

describe('the crawl lists the snapshot files Jest’s haste map lists', () => {
  test('over one tree: ignore patterns on directories and files, node_modules, VCS, names, symlinks', async () => {
    const dir = tree([
      'dir/__snapshots__/a.test.js.snap',
      'hidden/__snapshots__/b.test.js.snap',
      'src/__snapshots__/c.test.js.snap',
      'src/node_modules/pkg/__snapshots__/d.test.js.snap',
      'node_modules/pkg/__snapshots__/e.test.js.snap',
      'src/.git/__snapshots__/f.test.js.snap',
      'src/.hg/f.test.js.snap',
      'src/.sl/f.test.js.snap',
      'src/x.git/__snapshots__/g.test.js.snap',
      'src/my_node_modules/__snapshots__/h.test.js.snap',
      'src/__snapshots__/i.test.js.SNAP',
      'src/__snapshots__/j.test.js.snap.bak',
      'src/__snapshots__/.snap',
      'src/__snapshots__/k.snap',
      'real/__snapshots__/l.test.js.snap',
    ])
    symlinkSync(join(dir, 'real'), join(dir, 'link'))
    symlinkSync(
      join(dir, 'src/__snapshots__/c.test.js.snap'),
      join(dir, 'src/__snapshots__/m.test.js.snap'),
    )
    const patterns = ['/dir$', '/hidden/']
    const expected = await hasteSnapFiles({ rootDir: dir, modulePathIgnorePatterns: patterns })
    assert.ok(expected.length >= 3, 'Jest lists files')
    assert.deepEqual(crawledSnapFiles([dir], patterns), expected)
  })

  test('a root inside node_modules or a version-control directory has nothing', async () => {
    for (const host of ['host/node_modules/proj', 'host/.git/proj', 'host/.hg/proj', '.sl/proj']) {
      const dir = tree([`${host}/__snapshots__/a.test.js.snap`])
      const root = join(dir, host)
      const expected = await hasteSnapFiles({ rootDir: root })
      assert.deepEqual(expected, [], `Jest lists nothing under ${host}`)
      assert.deepEqual(crawledSnapFiles([root], []), expected, host)
    }
  })

  test('a root that is a symlink is entered, and a file under two roots is listed once', async () => {
    const dir = tree(['real/__snapshots__/a.test.js.snap', 'other/__snapshots__/b.test.js.snap'])
    symlinkSync(join(dir, 'real'), join(dir, 'link'))
    const expected = await hasteSnapFiles({
      rootDir: dir,
      roots: ['<rootDir>/link', '<rootDir>/other', '<rootDir>/other'],
    })
    assert.equal(expected.length, 2)
    assert.deepEqual(
      crawledSnapFiles([join(dir, 'link'), join(dir, 'other'), join(dir, 'other')], []),
      expected,
    )
  })
})
