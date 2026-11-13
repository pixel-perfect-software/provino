// T6.5's bar: the rebuilt Spikes C corpus has at least 60 checks (30 behaviours under two policies)
// and none fail. Never lower the count or skip a behaviour to make this pass.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BEHAVIOURS } from './behaviours.ts'
import { runLazyCheck } from './check.ts'
import { VARIANTS } from './run.ts'

test('the corpus has 30 behaviours under 2 policies', () => {
  assert.ok(BEHAVIOURS.length >= 30)
  assert.deepEqual(
    VARIANTS.map((variant) => variant.name),
    ['jest', 'neutral'],
  )
})

test('every behaviour passes under every policy on the real core', async () => {
  const summary = await runLazyCheck()
  const failures = summary.results
    .filter((r) => !r.ok)
    .map((r) => `[${r.policy}] ${r.behaviour}: ${r.failure}`)
  assert.deepEqual(failures, [])
  assert.ok(summary.checks >= 60, `only ${summary.checks} checks`)
  assert.equal(summary.failed, 0)
})
