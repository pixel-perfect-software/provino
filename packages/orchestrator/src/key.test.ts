// WorkerKey hashing: stable across key order, sensitive to every field the key carries.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hashOf, sameWorkerKey, stableJson, workerKeyOf } from './key.ts'

const base = {
  project: 'web',
  pool: 'forks',
  environment: 'node',
  environmentOptions: {},
  execArgv: [],
} as const

describe('stableJson', () => {
  it('sorts keys at every depth and leaves arrays in order', () => {
    assert.equal(
      stableJson({ b: [2, { z: 1, a: 2 }], a: null, c: 'x' }),
      '{"a":null,"b":[2,{"a":2,"z":1}],"c":"x"}',
    )
  })

  it('writes a plain scalar as JSON does', () => {
    assert.equal(stableJson('a"b'), '"a\\"b"')
    assert.equal(stableJson(3), '3')
    assert.equal(stableJson(null), 'null')
  })
})

describe('hashOf', () => {
  it('is the same for objects that differ only in key order', () => {
    assert.equal(hashOf({ a: 1, b: { c: 2, d: 3 } }), hashOf({ b: { d: 3, c: 2 }, a: 1 }))
  })

  it('differs when a value differs, and is a SHA-1 in hex', () => {
    assert.notEqual(hashOf({ a: 1 }), hashOf({ a: 2 }))
    assert.match(hashOf({}), /^[0-9a-f]{40}$/)
  })
})

describe('workerKeyOf', () => {
  it('gives the same key for environment options in a different order', () => {
    const a = workerKeyOf({ ...base, environmentOptions: { url: 'x', quirks: true } })
    const b = workerKeyOf({ ...base, environmentOptions: { quirks: true, url: 'x' } })
    assert.deepEqual(a, b)
    assert.ok(sameWorkerKey(a, b))
  })

  it('carries the project, pool and environment name as they are', () => {
    const key = workerKeyOf(base)
    assert.equal(key.project, 'web')
    assert.equal(key.pool, 'forks')
    assert.equal(key.environment, 'node')
  })

  it('treats no env overrides as the empty object', () => {
    assert.equal(workerKeyOf(base).envHash, hashOf({}))
    assert.equal(workerKeyOf({ ...base, env: {} }).envHash, hashOf({}))
  })

  it('changes with each field', () => {
    const key = workerKeyOf(base)
    const others = [
      workerKeyOf({ ...base, project: 'api' }),
      workerKeyOf({ ...base, pool: 'threads' }),
      workerKeyOf({ ...base, environment: 'jsdom' }),
      workerKeyOf({ ...base, environmentOptions: { url: 'x' } }),
      workerKeyOf({ ...base, execArgv: ['--max-old-space-size=512'] }),
      workerKeyOf({ ...base, env: { TZ: 'UTC' } }),
    ]
    for (const other of others) assert.equal(sameWorkerKey(key, other), false)
  })

  it('keeps execArgv in order, since flags can depend on it', () => {
    const a = workerKeyOf({ ...base, execArgv: ['--a', '--b'] })
    const b = workerKeyOf({ ...base, execArgv: ['--b', '--a'] })
    assert.equal(sameWorkerKey(a, b), false)
  })
})
