import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HoistPolicy } from '@provino/types'
import { blockPolicy } from '../hoist/test-policies.ts'
import { type FingerprintInputs, pipelineFingerprint } from './fingerprint.ts'

const base: FingerprintInputs = {
  versions: { transform: '0.0.0', code: 'a', oxcTransform: '0.1.0', oxcParser: '0.1.0' },
  typescript: 'oxc',
  nodeVersion: 'v24.0.0',
  tsconfig: 'auto',
  jsx: undefined,
  define: undefined,
  hoist: blockPolicy,
  transformers: null,
  runnerForm: false,
}

function differs(change: Partial<FingerprintInputs>): boolean {
  return pipelineFingerprint({ ...base, ...change }) !== pipelineFingerprint(base)
}

test('the fingerprint is stable, and each input moves it', () => {
  assert.equal(pipelineFingerprint(base), pipelineFingerprint({ ...base }))
  assert.ok(differs({ versions: { ...base.versions, oxcTransform: '0.2.0' } }), 'oxc-transform')
  assert.ok(differs({ versions: { ...base.versions, oxcParser: '0.2.0' } }), 'oxc-parser')
  assert.ok(differs({ versions: { ...base.versions, transform: '0.0.1' } }), 'this package')
  assert.ok(differs({ versions: { ...base.versions, code: 'b' } }), 'this package’s code')
  assert.ok(differs({ jsx: { runtime: 'classic' } }), 'jsx options')
  assert.ok(differs({ define: { 'process.env.NODE_ENV': '"test"' } }), 'define')
  assert.ok(differs({ tsconfig: false }), 'tsconfig mode')
  assert.ok(differs({ typescript: 'off' }), 'typescript mode')
  assert.ok(differs({ transformers: 'a-host' }), 'transformer host')
  assert.ok(differs({ hoist: null }), 'no hoisting')
  assert.ok(differs({ runnerForm: true }), 'keeping the runner form')
})

test('the hoist policy moves it, in any of its parts', () => {
  const refs = blockPolicy.factoryReferences
  assert.ok(typeof refs === 'object')
  const changed: HoistPolicy = { ...blockPolicy, placement: 'top-level-only' }
  assert.ok(differs({ hoist: changed }))
  assert.ok(differs({ hoist: { ...blockPolicy, hoistCalls: { mock: 'one-string' } } }))
  assert.ok(
    differs({
      hoist: {
        ...blockPolicy,
        factoryReferences: { ...refs, allowPattern: /^other/ },
      },
    }),
  )
  assert.ok(
    differs({
      hoist: {
        ...blockPolicy,
        factoryReferences: {
          ...refs,
          allowGlobals: new Set(['Math']),
        },
      },
    }),
  )
})

test('the Node version moves it under strip mode only', () => {
  const stripped: FingerprintInputs = { ...base, typescript: 'node-strip' }
  const other = { ...stripped, nodeVersion: 'v24.1.0' }
  assert.notEqual(pipelineFingerprint(stripped), pipelineFingerprint(other))
  assert.equal(
    pipelineFingerprint(base),
    pipelineFingerprint({ ...base, nodeVersion: 'v24.1.0' }),
    'Oxc output does not depend on the Node version',
  )
})
