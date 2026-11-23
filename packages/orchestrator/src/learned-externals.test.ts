import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, it } from 'provino'
import { createResultsCache } from './cache.ts'
import { learnExternals, packageVersionOf, readLearnedExternals } from './learned-externals.ts'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A project root with `node_modules/<name>` at `version`, its `index.js` and a cache directory. */
function tree(packages: Readonly<Record<string, string | null>>): string {
  const root = mkdtempSync(join(tmpdir(), 'provino-learned-'))
  roots.push(root)
  for (const [name, version] of Object.entries(packages)) {
    const dir = join(root, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify(version === null ? { name } : { name, version }),
    )
    writeFileSync(join(dir, 'index.js'), 'module.exports = {}\n')
  }
  return root
}

describe('the learned externals in the results cache (D127)', () => {
  it('reads the package version of a scoped and a plain package, and none without one', () => {
    const root = tree({ plain: '1.2.3', '@scope/pkg': '4.5.6', bare: null })
    const memo = new Map<string, string>()
    assert.equal(packageVersionOf(join(root, 'node_modules/plain/index.js'), memo), '1.2.3')
    assert.equal(packageVersionOf(join(root, 'node_modules/@scope/pkg/index.js'), memo), '4.5.6')
    assert.equal(packageVersionOf(join(root, 'node_modules/bare/index.js'), memo), '')
    assert.equal(packageVersionOf(join(root, 'src/a.js'), memo), '')
  })

  it('drops an entry whose package has another version, and one whose file is gone', async () => {
    const root = tree({ kept: '1.0.0', upgraded: '1.0.0', removed: '1.0.0' })
    const dir = join(root, 'cache')
    const learning = createResultsCache(dir)
    learnExternals(
      learning,
      'p',
      root,
      ['kept', 'upgraded', 'removed'].map((name) => join(root, 'node_modules', name, 'index.js')),
      new Map(),
    )
    await learning.write()

    // A reinstall: one package upgraded in place, one removed.
    writeFileSync(
      join(root, 'node_modules/upgraded/package.json'),
      JSON.stringify({ name: 'upgraded', version: '2.0.0' }),
    )
    rmSync(join(root, 'node_modules/removed'), { recursive: true })

    const reading = createResultsCache(dir)
    assert.deepEqual(readLearnedExternals(reading, 'p', root, new Map()), [
      join(root, 'node_modules/kept/index.js'),
    ])
    // The run that read the set ran a file of the project, so the key has history and is kept.
    reading.record('p', 'a.test.js', { durationMs: 1, failed: false, tests: 1, at: 1 })
    await reading.write()
    assert.deepEqual(
      [...createResultsCache(dir).externals('p')],
      [['node_modules/kept/index.js', '1.0.0']],
      'the stale entries are gone from the file too',
    )
  })
})
