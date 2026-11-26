// The bootstrap canary (B27g2, D191): this repo's suites run on the pinned runner, so a runner that
// reports green wrongly would pass them all. The canary guards that runner, not the checkout's build.
// This file stays on node:test (it is in `tooling/provino/bootstrap.json`) and runs the pinned runner
// on fixtures that fail in the ways the
// migrated suites fail: every run must exit 1 and report the counts the fixture is built to have,
// and one all-passing fixture must exit 0, so the canary cannot pass on a bin that fails everything.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runBuiltAsync, trackedProjects, withoutNodeNoise } from '../support.ts'

/**
 * The pinned runner's bin: `RUNNER_BIN` in `tooling/packaging/src/dogfood.ts`, repeated here because
 * the boundaries manifest does not let a package's tests import tooling. `dogfood.test.ts` holds the
 * two equal.
 */
const PINNED_BIN = fileURLToPath(
  new URL('../../../../node_modules/provino-runner/dist/cli.js', import.meta.url),
)

const project = trackedProjects()

/** The pinned runner on `files` (config `include` `tests/**`, or the one given), and what it printed. */
async function runFixture(
  files: Readonly<Record<string, string>>,
  include = 'tests/**/*.test.mjs',
) {
  const { dir } = await project(
    Object.fromEntries(Object.entries(files).map(([name, text]) => [`tests/${name}`, text])),
    `export default { include: [${JSON.stringify(include)}] }\n`,
  )
  const ran = await runBuiltAsync(['run', '--config', 'provino.config.mjs'], {
    cwd: dir,
    bin: PINNED_BIN,
  })
  const output = `${ran.stdout}\n${withoutNodeNoise(ran.stderr)}`
  // A bin that crashed or timed out has no status: that is not a result to count.
  assert.ok(ran.status !== null && Number.isFinite(ran.status), `no exit status: ${output}`)
  assert.equal(ran.signal, null, `ended by ${String(ran.signal)}: ${output}`)
  return { status: ran.status, output }
}

// The cases do not share state, and each boots the bin: run them together.
describe('the runner under test reports failures', { concurrency: true }, () => {
  test('all-passing tests end with exit 0 and their counts', async () => {
    const ran = await runFixture({
      'green.test.mjs': `import { expect, test } from 'provino'

test('passes: one', () => { expect(1).toBe(1) })
test('passes: two', () => { expect('a').toBe('a') })
`,
    })
    assert.equal(ran.status, 0, ran.output)
    assert.match(ran.output, /Tests:\s+2 passed, 2 total/, ran.output)
    assert.doesNotMatch(ran.output, /failed/, ran.output)
  })

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

  test('a config whose include matches nothing ends 1 with no test found, never green', async () => {
    const ran = await runFixture(
      { 'present.test.mjs': `import { test } from 'provino'\ntest('passes', () => {})\n` },
      'nowhere/**/*.test.mjs',
    )
    assert.equal(ran.status, 1, ran.output)
    assert.match(ran.output, /Test Suites:\s+0 total/, ran.output)
    assert.match(ran.output, /Tests:\s+0 total/, ran.output)
    assert.doesNotMatch(ran.output, /\d+ passed/, ran.output)
  })
})
