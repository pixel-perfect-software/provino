import assert from 'node:assert/strict'
import { test } from 'provino'
import { runHtmlLeg } from './html.ts'

// 40 files (1,000 tests) and one measured round: the shape of the result, with no bar and no
// reading of the time.
test('the html leg measures a page of every test passing and one with the stream’s failures', async () => {
  const result = await runHtmlLeg(40, 1)
  assert.equal(result.files, 40)
  assert.equal(result.rounds, 1)
  assert.deepEqual(
    result.variants.map((variant) => variant.name),
    ['passing', 'failures'],
  )
  const [passing, failing] = result.variants
  assert.ok(passing !== undefined && failing !== undefined)
  assert.equal(passing.tests, 1000)
  assert.equal(failing.tests, 1000)
  assert.equal(passing.failures, 0)
  assert.ok(failing.failures > 0, 'the stream’s failure rate gives a page with failures')
  for (const variant of result.variants) {
    for (const value of [variant.noopMs, variant.htmlMs, variant.buildMs, variant.kb]) {
      assert.ok(Number.isFinite(value) && value >= 0, `${variant.name}: ${value}`)
    }
    assert.equal(variant.buildMs, variant.htmlMs - variant.noopMs)
    // The page is its script, its styles and the rows: tens of KB at least.
    assert.ok(variant.kb > 40, `${variant.name} page is ${variant.kb} KB`)
  }
  // Failures add their text to the page.
  assert.ok(failing.kb > passing.kb)
})
