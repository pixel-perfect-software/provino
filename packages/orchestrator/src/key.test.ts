// WorkerKey hashing: stable across key order, sensitive to every field the key carries.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hashOf, sameWorkerKey, stableJson, workerKeyId, workerKeyOf } from './key.ts'

const base = {
  project: 'web',
  pool: 'forks',
  isolation: 'registry',
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
      workerKeyOf({ ...base, isolation: 'realm' }),
      workerKeyOf({ ...base, isolation: 'process' }),
      workerKeyOf({ ...base, environment: 'jsdom' }),
      workerKeyOf({ ...base, environmentOptions: { url: 'x' } }),
      workerKeyOf({ ...base, execArgv: ['--max-old-space-size=512'] }),
      workerKeyOf({ ...base, env: { TZ: 'UTC' } }),
    ]
    for (const other of others) assert.equal(sameWorkerKey(key, other), false)
  })

  it('leaves the dialect off the key when none is given', () => {
    const key = workerKeyOf(base)
    assert.equal('dialect' in key, false)
    assert.equal(workerKeyOf({ ...base, dialect: 'vitest' }).dialect, 'vitest')
  })

  it('keeps execArgv in order, since flags can depend on it', () => {
    const a = workerKeyOf({ ...base, execArgv: ['--a', '--b'] })
    const b = workerKeyOf({ ...base, execArgv: ['--b', '--a'] })
    assert.equal(sameWorkerKey(a, b), false)
  })
})

describe('the dialect of a worker key', () => {
  it('keeps workers of two dialects apart, in the match and in the id', () => {
    const jest = workerKeyOf({ ...base, dialect: 'jest' })
    const vitest = workerKeyOf({ ...base, dialect: 'vitest' })
    assert.equal(sameWorkerKey(jest, vitest), false)
    assert.notEqual(workerKeyId(jest), workerKeyId(vitest))
    assert.equal(sameWorkerKey(jest, workerKeyOf({ ...base, dialect: 'jest' })), true)
  })

  it('tells a worker with a dialect from one with none', () => {
    const named = workerKeyOf({ ...base, dialect: 'jest' })
    const bare = workerKeyOf(base)
    assert.equal(sameWorkerKey(named, bare), false)
    assert.notEqual(workerKeyId(named), workerKeyId(bare))
  })

  it('treats two keys with no dialect as the same, as before', () => {
    const a = workerKeyOf(base)
    const b = workerKeyOf({ ...base })
    assert.ok(sameWorkerKey(a, b))
    assert.equal(workerKeyId(a), workerKeyId(b))
  })
})
