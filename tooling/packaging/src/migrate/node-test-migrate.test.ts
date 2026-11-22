// rewrite then verify on generated packages: what is recorded, what is written, what verify says,
// and what happens when the baseline or a write goes wrong.
import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { formatDifference, isEmptyDifference } from './node-test-compare.ts'
import {
  baselinePath,
  findPackage,
  readBaseline,
  rewritePackage,
  verifyPackage,
  writeBaseline,
} from './node-test-migrate.ts'
import { fakeRunner, fixturePackage, THREE_REPORT, THREE_TESTS } from './test-support.ts'

async function recorded(files: Record<string, string>) {
  const fixture = await fixturePackage(files)
  const report = await rewritePackage({
    packageDir: fixture.pkg,
    root: fixture.root,
    cacheDir: fixture.cache,
    dryRun: false,
  })
  return { ...fixture, report }
}

const verify = (f: { root: string; pkg: string; cache: string }, runner: string) =>
  verifyPackage({ packageDir: f.pkg, root: f.root, cacheDir: f.cache, runner, config: undefined })

describe('rewrite then verify', () => {
  it('records what node:test reported, rewrites, and verifies a matching run', async () => {
    const f = await recorded({ 'src/a.test.ts': THREE_TESTS })
    assert.deepEqual(f.report.rewritten, ['src/a.test.ts'])
    assert.equal(f.report.baselineTests, 3)
    assert.match(await readFile(join(f.pkg, 'src/a.test.ts'), 'utf8'), /from 'provino'/)
    const runner = await fakeRunner(f.root, THREE_REPORT)
    const verified = await verify(f, runner)
    assert.equal(verified.tests, 3)
    assert.ok(isEmptyDifference(verified.difference), formatDifference(verified.difference))
  })

  it('verify fails on a missing test, an extra test and a changed status', async () => {
    const f = await recorded({ 'src/a.test.ts': THREE_TESTS })
    const runner = await fakeRunner(f.root, [
      ['suite > passes', 'failed'],
      ['suite > extra', 'passed'],
      ['suite > fails', 'failed'],
    ])
    const { difference } = await verify(f, runner)
    assert.deepEqual(
      difference.missing.map((r) => r.name),
      ['suite > skipped'],
    )
    assert.deepEqual(
      difference.extra.map((r) => r.name),
      ['suite > extra'],
    )
    assert.deepEqual(
      difference.changed.map((r) => r.name),
      ['suite > passes'],
    )
  })

  it('writes nothing when a site is refused, and says where', async () => {
    const refused = `${THREE_TESTS}describe('later', async () => {})\n`
    const f = await recorded({ 'src/a.test.ts': refused })
    assert.deepEqual(f.report.rewritten, [])
    assert.deepEqual(
      f.report.refusals.map((r) => r.line),
      [8],
    )
    assert.equal(await readFile(join(f.pkg, 'src/a.test.ts'), 'utf8'), refused)
    await assert.rejects(verify(f, 'x.ts'), { code: 'MIGRATE_NO_BASELINE' })
  })

  it('a dry run writes neither files nor a baseline; a second rewrite is a no-op that keeps it', async () => {
    const f = await fixturePackage({ 'src/a.test.ts': THREE_TESTS })
    const options = { packageDir: f.pkg, root: f.root, cacheDir: f.cache }
    const dry = await rewritePackage({ ...options, dryRun: true })
    assert.equal(dry.candidates, 1)
    assert.equal(await readFile(join(f.pkg, 'src/a.test.ts'), 'utf8'), THREE_TESTS)
    assert.equal(await readBaseline(baselinePath(f.cache, f.pkg, f.root)), undefined)
    await rewritePackage({ ...options, dryRun: false })
    const first = await readFile(join(f.pkg, 'src/a.test.ts'), 'utf8')
    const again = await rewritePackage({ ...options, dryRun: false })
    assert.deepEqual(again.rewritten, [])
    assert.equal(await readFile(join(f.pkg, 'src/a.test.ts'), 'utf8'), first)
    const verified = await verify(f, await fakeRunner(f.root, THREE_REPORT))
    assert.equal(verified.tests, 3)
  })

  it('a second file rewritten later joins the baseline, and a deleted file leaves it', async () => {
    const f = await fixturePackage({ 'src/a.test.ts': THREE_TESTS })
    const options = { packageDir: f.pkg, root: f.root, cacheDir: f.cache, dryRun: false }
    await rewritePackage(options)
    await writeFile(
      join(f.pkg, 'src/b.test.ts'),
      "import { it } from 'node:test'\nit('only', () => {})\n",
    )
    await rewritePackage(options)
    const path = baselinePath(f.cache, f.pkg, f.root)
    assert.deepEqual(Object.keys((await readBaseline(path))?.files ?? {}).sort(), [
      'src/a.test.ts',
      'src/b.test.ts',
    ])
    const { rm } = await import('node:fs/promises')
    await rm(join(f.pkg, 'src/a.test.ts'))
    await writeFile(
      join(f.pkg, 'src/c.test.ts'),
      "import { it } from 'node:test'\nit('c', () => {})\n",
    )
    await rewritePackage(options)
    assert.deepEqual(Object.keys((await readBaseline(path))?.files ?? {}).sort(), [
      'src/b.test.ts',
      'src/c.test.ts',
    ])
  })

  it('verifies a skipped suite and a [slug].test.ts, which node:test and Provino list differently', async () => {
    const source =
      "import { describe, it } from 'node:test'\ndescribe.skip('s', () => { it('c', () => {}) })\nit('x', () => {})\n"
    const f = await recorded({ 'src/[slug].test.ts': source })
    assert.deepEqual(f.report.rewritten, ['src/[slug].test.ts'])
    const runner = await fakeRunner(f.root, [
      ['s > c', 'skipped'],
      ['x', 'passed'],
    ])
    // The stand-in reports its tests under src/a.test.ts: point it at the real file name.
    const text = (await readFile(runner, 'utf8')).replaceAll('src/a.test.ts', 'src/[slug].test.ts')
    await writeFile(runner, text)
    const { difference } = await verify(f, runner)
    assert.ok(isEmptyDifference(difference), formatDifference(difference))
  })
})

describe('the baseline file', () => {
  it('is undefined only when there is none; a corrupt, mis-shaped or unreadable one is MIGRATE_BASELINE', async () => {
    const f = await fixturePackage({})
    const path = join(f.cache, 'x.baseline.json')
    assert.equal(await readBaseline(path), undefined)
    await mkdir(f.cache, { recursive: true })
    await writeFile(path, '{not json')
    await assert.rejects(readBaseline(path), { code: 'MIGRATE_BASELINE' })
    for (const shape of [
      '[]',
      '{"package":"p","nodeVersion":"v","files":{"a":[{"file":"a","name":"n","status":"nope"}]}}',
      '{"package":"p","files":{}}',
    ]) {
      await writeFile(path, shape)
      await assert.rejects(readBaseline(path), { code: 'MIGRATE_BASELINE' }, shape)
    }
    await mkdir(join(f.cache, 'dir.baseline.json'))
    await assert.rejects(readBaseline(join(f.cache, 'dir.baseline.json')), {
      code: 'MIGRATE_BASELINE',
    })
  })

  it('round-trips, and rewrite and verify refuse a corrupt one instead of redoing it', async () => {
    const f = await fixturePackage({ 'src/a.test.ts': THREE_TESTS })
    const path = baselinePath(f.cache, f.pkg, f.root)
    await writeBaseline(path, { package: 'pkg', nodeVersion: process.version, files: {} })
    assert.deepEqual((await readBaseline(path))?.files, {})
    await writeFile(path, 'garbage')
    await assert.rejects(
      rewritePackage({ packageDir: f.pkg, root: f.root, cacheDir: f.cache, dryRun: false }),
      { code: 'MIGRATE_BASELINE' },
    )
    assert.equal(await readFile(join(f.pkg, 'src/a.test.ts'), 'utf8'), THREE_TESTS)
    await assert.rejects(verify(f, 'x.ts'), { code: 'MIGRATE_BASELINE' })
  })

  it('puts the originals back when a file cannot be written', async (t) => {
    if (process.getuid?.() === 0) return t.skip('root can write a read-only file')
    const second = "import { it } from 'node:test'\nit('b', () => {})\n"
    const f = await fixturePackage({ 'src/a.test.ts': THREE_TESTS, 'src/b.test.ts': second })
    await chmod(join(f.pkg, 'src/b.test.ts'), 0o444)
    await assert.rejects(
      rewritePackage({ packageDir: f.pkg, root: f.root, cacheDir: f.cache, dryRun: false }),
      { code: 'MIGRATE_WRITE' },
    )
    assert.equal(await readFile(join(f.pkg, 'src/a.test.ts'), 'utf8'), THREE_TESTS)
    assert.equal(await readFile(join(f.pkg, 'src/b.test.ts'), 'utf8'), second)
  })
})

describe('finding the package', () => {
  it('takes a path, a directory, a bare name and a workspace name', () => {
    const core = findPackage('packages/core')
    assert.match(core, /packages\/core$/)
    assert.equal(findPackage('core'), core)
    assert.equal(findPackage('@provino/core'), core)
    assert.equal(findPackage(core), core)
    assert.match(findPackage('tooling/packaging'), /tooling\/packaging$/)
    assert.throws(() => findPackage('no-such-package'), { code: 'MIGRATE_USAGE' })
  })
})
