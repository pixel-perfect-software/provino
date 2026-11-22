// The bootstrap canary (B27g2, D203): this repo's suites run on this checkout's own built bin, so a
// runner that reports green wrongly would pass them all. This file stays on node:test (it is in
// `tooling/provino/bootstrap.json`) and runs the built bin on a fixture with two passing and two
// failing tests; the run must exit 1 and report both counts.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { runBuilt, trackedProjects, withoutNodeNoise } from '../support.ts'

const project = trackedProjects()

const FIXTURE = `import { expect, test } from 'provino'

test('passes: arithmetic', () => { expect(1 + 1).toBe(2) })
test('passes: strings', () => { expect('a' + 'b').toBe('ab') })
test('fails: arithmetic', () => { expect(1 + 1).toBe(3) })
test('fails: strings', () => { expect('a' + 'b').toBe('ba') })
`

describe('the runner under test reports failures', () => {
  test('a fixture with two passing and two failing tests ends with exit 1 and both counts', async () => {
    const { dir } = await project(
      { 'tests/canary.test.mjs': FIXTURE },
      "export default { include: ['tests/**/*.test.mjs'] }\n",
    )
    const ran = runBuilt(['run', '--config', 'provino.config.mjs'], { cwd: dir })
    const output = `${ran.stdout}\n${withoutNodeNoise(ran.stderr)}`
    assert.equal(ran.status, 1, output)
    assert.match(output, /Tests:\s+2 failed, 2 passed, 4 total/, output)
    assert.match(output, /fails: arithmetic/, output)
    assert.match(output, /fails: strings/, output)
  })
})
