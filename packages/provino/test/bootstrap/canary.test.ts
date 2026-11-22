// The bootstrap canary (B27g2, D203): this repo's suites run on this checkout's own built bin, so a
// runner that reports green wrongly would pass them all. This file stays on node:test (it is in
// `tooling/provino/bootstrap.json`) and runs the built bin on fixtures that fail in the ways the
// migrated suites fail: every run must exit 1 and report the counts the fixture is built to have.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { runBuilt, trackedProjects, withoutNodeNoise } from '../support.ts'

const project = trackedProjects()

/** The built bin on `files` (config `include` `tests/**`, or the one given), and what it printed. */
async function runFixture(
  files: Readonly<Record<string, string>>,
  include = 'tests/**/*.test.mjs',
) {
  const { dir } = await project(
    Object.fromEntries(Object.entries(files).map(([name, text]) => [`tests/${name}`, text])),
    `export default { include: [${JSON.stringify(include)}] }\n`,
  )
  const ran = runBuilt(['run', '--config', 'provino.config.mjs'], { cwd: dir })
  return { status: ran.status, output: `${ran.stdout}\n${withoutNodeNoise(ran.stderr)}` }
}

describe('the runner under test reports failures', () => {
  test('two passing and two failing tests end with exit 1 and both counts', async () => {
    const ran = await runFixture({
      'flat.test.mjs': `import { expect, test } from 'provino'

test('passes: arithmetic', () => { expect(1 + 1).toBe(2) })
test('passes: strings', () => { expect('a' + 'b').toBe('ab') })
test('fails: arithmetic', () => { expect(1 + 1).toBe(3) })
test('fails: strings', () => { expect('a' + 'b').toBe('ba') })
`,
    })
    assert.equal(ran.status, 1, ran.output)
    assert.match(ran.output, /Tests:\s+2 failed, 2 passed, 4 total/, ran.output)
    assert.match(ran.output, /fails: arithmetic/, ran.output)
    assert.match(ran.output, /fails: strings/, ran.output)
  })

  test('a node:assert/strict failure inside a nested describe fails that test only', async () => {
    const ran = await runFixture({
      'nested.test.mjs': `import assert from 'node:assert/strict'
import { describe, test } from 'provino'

describe('outer', () => {
  describe('inner', () => {
    test('passes', () => { assert.equal(1, 1) })
    test('fails by assert', () => { assert.equal(1, 2) })
  })
})
`,
    })
    assert.equal(ran.status, 1, ran.output)
    assert.match(ran.output, /Tests:\s+1 failed, 1 passed, 2 total/, ran.output)
    assert.match(ran.output, /fails by assert/, ran.output)
  })

  test('an async test whose promise rejects fails', async () => {
    const ran = await runFixture({
      'async.test.mjs': `import { test } from 'provino'

test('passes', async () => { await Promise.resolve() })
test('rejects', async () => { await Promise.reject(new Error('rejected on purpose')) })
`,
    })
    assert.equal(ran.status, 1, ran.output)
    assert.match(ran.output, /Tests:\s+1 failed, 1 passed, 2 total/, ran.output)
    assert.match(ran.output, /rejected on purpose/, ran.output)
  })

  test('a throwing beforeEach fails every test it guards', async () => {
    const ran = await runFixture({
      'hook.test.mjs': `import { beforeEach, describe, test } from 'provino'

describe('guarded', () => {
  beforeEach(() => { throw new Error('hook threw on purpose') })
  test('first', () => {})
  test('second', () => {})
})
test('unguarded passes', () => {})
`,
    })
    assert.equal(ran.status, 1, ran.output)
    assert.match(ran.output, /Tests:\s+2 failed, 1 passed, 3 total/, ran.output)
    assert.match(ran.output, /hook threw on purpose/, ran.output)
  })

  test('a file that throws at import fails the run and does not hide the other file', async () => {
    const ran = await runFixture({
      'broken.test.mjs': `import { test } from 'provino'

throw new Error('import threw on purpose')
test('never registered', () => {})
`,
      'fine.test.mjs': `import { test } from 'provino'

test('passes', () => {})
`,
    })
    assert.equal(ran.status, 1, ran.output)
    assert.match(ran.output, /import threw on purpose/, ran.output)
    assert.match(ran.output, /Test Suites:\s+1 failed, 1 passed, 2 total/, ran.output)
  })

  test('a config whose include matches nothing ends non-zero and reports nothing passed', async () => {
    const ran = await runFixture(
      { 'present.test.mjs': `import { test } from 'provino'\ntest('passes', () => {})\n` },
      'nowhere/**/*.test.mjs',
    )
    assert.notEqual(ran.status, 0, ran.output)
    assert.doesNotMatch(ran.output, /\d+ passed/, ran.output)
  })
})
