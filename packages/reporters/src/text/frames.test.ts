// Provino's own frames are hidden from failure text wherever Jest hides its own (D104): the user's
// frames stay, from a workspace checkout (`packages/<name>/src`) and from an install
// (`node_modules/provino/dist`, `node_modules/@provino/<name>`).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { error } from '../internal/test-support.ts'
import { formatError, frames, isProvinoFrame } from './format.ts'

/** `<repo>/packages/`, where this checkout's packages are. */
const PACKAGES = fileURLToPath(new URL('../../../', import.meta.url))

function stackOf(...lines: string[]): string {
  return ['Error: boom', ...lines.map((line) => `    at ${line}`)].join('\n')
}

test('a checkout’s core and worker frames are left out, the test’s own stay', () => {
  const stack = stackOf(
    `Object.<anonymous> (/work/app/a.test.ts:3:11)`,
    `run (${PACKAGES}core/src/executor/executor.ts:640:9)`,
    `start (${PACKAGES}orchestrator/src/worker/start.ts:210:5)`,
    `file://${PACKAGES}provino/src/cli.ts:5:1`,
  )
  assert.deepEqual(frames(error('boom', { stack })), [
    'at Object.<anonymous> (/work/app/a.test.ts:3:11)',
  ])
})

test('an install’s frames are left out as a dependency’s are', () => {
  const stack = stackOf(
    `Object.<anonymous> (/work/app/a.test.ts:3:11)`,
    `run (/work/app/node_modules/provino/dist/worker/jest-runtime.js:1:100)`,
    `run (/work/app/node_modules/@provino/core/dist/index.js:1:100)`,
  )
  assert.deepEqual(frames(error('boom', { stack })), [
    'at Object.<anonymous> (/work/app/a.test.ts:3:11)',
  ])
})

test('a user’s own packages/core/src file is not Provino’s', () => {
  const stack = stackOf(`helper (/work/monorepo/packages/core/src/helper.ts:9:3)`)
  assert.deepEqual(frames(error('boom', { stack })), [
    'at helper (/work/monorepo/packages/core/src/helper.ts:9:3)',
  ])
  assert.match(formatError(error('boom', { stack })), /helper\.ts:9:3/)
})

test('a checkout under a path with a space is found through the percent-encoded frame', () => {
  const packages = '/work/my app/provino/packages/'
  assert.equal(
    isProvinoFrame(`at run (file:///work/my%20app/provino/packages/core/src/x.ts:1:1)`, packages),
    true,
  )
  assert.equal(isProvinoFrame(`at run (${packages}core/src/x.ts:1:1)`, packages), true)
})

test('the built umbrella of a checkout is Provino’s, a test or fixture under packages/ is not', () => {
  const packages = '/work/provino/packages/'
  assert.equal(isProvinoFrame(`at run (${packages}provino/dist/worker/a.js:1:1)`, packages), true)
  assert.equal(isProvinoFrame(`at t (${packages}provino/test/run.test.ts:1:1)`, packages), false)
  assert.equal(isProvinoFrame(`at f (${packages}harness/fixtures/a/b.test.ts:1:1)`, packages), false)
})

test('an install’s frames are Provino’s whatever the checkout is', () => {
  assert.equal(
    isProvinoFrame('at r (/app/node_modules/provino/dist/worker/jest-runtime.js:1:1)', undefined),
    true,
  )
  assert.equal(isProvinoFrame('at r (/app/node_modules/@provino/core/dist/a.js:1:1)', undefined), true)
  assert.equal(isProvinoFrame('at r (/app/src/provino/dist/a.js:1:1)', undefined), false)
})
