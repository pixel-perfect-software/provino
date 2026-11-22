// main(): exit 0 for done, 1 for refused sites or a difference, 2 for bad usage or a failed step.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { main } from './cli.ts'
import { fakeRunner, fixturePackage, THREE_REPORT, THREE_TESTS } from './test-support.ts'

async function run(args: readonly string[], cacheDir: string) {
  const out: string[] = []
  const err: string[] = []
  const code = await main(args, { out: (l) => out.push(l), err: (l) => err.push(l), cacheDir })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('migrate:node-test', () => {
  it('rewrite --dry-run is 0 and writes nothing; rewrite then verify are 0', async () => {
    const f = await fixturePackage({ 'src/a.test.ts': THREE_TESTS })
    const dry = await run(['rewrite', f.pkg, '--dry-run'], f.cache)
    assert.equal(dry.code, 0)
    assert.match(
      dry.out,
      /1 file\(s\) import node:test, 0 refused site\(s\) \(dry run: nothing written\)/,
    )
    assert.equal(await readFile(join(f.pkg, 'src/a.test.ts'), 'utf8'), THREE_TESTS)

    const real = await run(['rewrite', f.pkg], f.cache)
    assert.equal(real.code, 0)
    assert.match(real.out, /1 rewritten; recorded 3 baseline test\(s\)/)
    const runner = await fakeRunner(f.root, THREE_REPORT)
    const verified = await run(['verify', f.pkg, '--runner', runner], f.cache)
    assert.equal(verified.code, 0)
    assert.match(verified.out, /verify: all 3 test\(s\) match/)
  })

  it('is 1 with every refused site listed, and 1 when verify finds a difference', async () => {
    const refused = await fixturePackage({
      'src/a.test.ts': `${THREE_TESTS}describe('x', async () => {})\nit('y', { concurrency: 2 }, () => {})\n`,
    })
    const ended = await run(['rewrite', refused.pkg], refused.cache)
    assert.equal(ended.code, 1)
    assert.match(ended.out, /MIGRATE_UNSUPPORTED .*a\.test\.ts:8:\d+ async describe callback/)
    assert.match(ended.out, /a\.test\.ts:9:\d+ option concurrency/)
    assert.match(ended.out, /nothing was written/)

    const f = await fixturePackage({ 'src/a.test.ts': THREE_TESTS })
    await run(['rewrite', f.pkg], f.cache)
    const runner = await fakeRunner(f.root, [['suite > passes', 'failed']])
    const differs = await run(['verify', f.pkg, '--runner', runner], f.cache)
    assert.equal(differs.code, 1)
    assert.match(differs.out, /changed {2}src\/a\.test\.ts: suite > passes \(pass -> fail\)/)
  })

  it('is 2 for each usage error, and a typo never rewrites', async () => {
    const f = await fixturePackage({ 'src/a.test.ts': THREE_TESTS })
    const cases: readonly (readonly string[])[] = [
      [],
      ['rewrite'],
      ['migrate', f.pkg],
      ['rewrite', f.pkg, '--dryrun'],
      ['rewrite', f.pkg, 'extra'],
      ['verify', f.pkg, '--dry-run'],
      ['rewrite', f.pkg, '--runner', 'x.ts'],
      ['rewrite', f.pkg, '--config', 'x.ts'],
      ['rewrite', f.pkg, '--runner'],
      ['rewrite', join(f.root, 'no-such-package')],
    ]
    for (const args of cases) {
      const ended = await run(args, f.cache)
      assert.equal(ended.code, 2, args.join(' '))
      assert.match(ended.err, /^MIGRATE_USAGE /, args.join(' '))
    }
    assert.equal(await readFile(join(f.pkg, 'src/a.test.ts'), 'utf8'), THREE_TESTS)
  })

  it('verify with no runner there says where the pinned runner goes', async () => {
    const f = await fixturePackage({ 'src/a.test.ts': THREE_TESTS })
    const missing = join(f.root, 'nowhere/cli.js')
    const ended = await run(['verify', f.pkg, '--runner', missing], f.cache)
    assert.equal(ended.code, 2)
    assert.equal(
      ended.err,
      `MIGRATE_USAGE no runner at ${missing}: install the provino-runner rc (B27g2) or pass --runner <cli.js>`,
    )
  })

  it('is 2 for a step that fails with a code: no baseline, and a test script it cannot read', async () => {
    const f = await fixturePackage({ 'src/a.test.ts': THREE_TESTS })
    const runner = await fakeRunner(f.root, [])
    const noBaseline = await run(['verify', f.pkg, '--runner', runner], f.cache)
    assert.equal(noBaseline.code, 2)
    assert.match(noBaseline.err, /^MIGRATE_NO_BASELINE /)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(f.pkg, 'package.json'), '{"name":"fixture","scripts":{"test":"vitest"}}')
    const script = await run(['rewrite', f.pkg], f.cache)
    assert.equal(script.code, 2)
    assert.match(script.err, /^MIGRATE_SCRIPT /)
  })
})
