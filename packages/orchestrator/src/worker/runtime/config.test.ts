import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { moduleRef, neutralPolicy, serializePolicy } from '@provino/policy'
import type { SerializedProjectConfig } from '@provino/types'
import { WorkerError } from '../errors.ts'
import { parseProjectConfig } from './config.ts'

const valid: SerializedProjectConfig = {
  name: 'p',
  rootDir: '/root',
  ci: false,
  policy: serializePolicy(neutralPolicy),
  environment: { module: '/env.ts', export: 'env', options: { a: 1 } },
  globals: moduleRef('/globals.ts', 'factory'),
  setupFiles: ['/setup.ts'],
  setupFilesAfterEnv: [],
  loader: {
    extensions: ['.ts'],
    conditions: ['node'],
    tsconfig: 'auto',
    mappers: [],
    typescript: 'oxc',
  },
}

/** A config with `path` (a dotted key) replaced by `value`; `undefined` deletes the key. */
function with_(path: string, value: unknown): unknown {
  const copy: Record<string, unknown> = { ...structuredClone(valid) }
  const keys = path.split('.')
  let target = copy
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>
  const last = keys.at(-1) as string
  if (value === undefined) delete target[last]
  else target[last] = value
  return copy
}

describe('parseProjectConfig', () => {
  it('returns a valid config’s pieces as they are', () => {
    const parsed = parseProjectConfig(structuredClone(valid))
    assert.deepEqual(parsed, valid)
  })

  it('accepts no globals, and a tsconfig of false or a path', () => {
    assert.equal(parseProjectConfig(with_('globals', null)).globals, null)
    assert.equal(parseProjectConfig(with_('loader.tsconfig', false)).loader.tsconfig, false)
    assert.equal(parseProjectConfig(with_('loader.tsconfig', '/t.json')).loader.tsconfig, '/t.json')
  })

  it('throws ORCH_BAD_CONFIG naming the key, for each piece that is missing or the wrong kind', () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['name', 3],
      ['rootDir', undefined],
      ['ci', 'false'],
      ['policy', []],
      ['policy.core', undefined],
      ['policy.expect', 'x'],
      ['environment', null],
      ['environment.module', undefined],
      ['environment.export', 1],
      ['environment.options', []],
      ['globals', { module: 'x' }],
      ['globals', undefined],
      ['setupFiles', 'a'],
      ['setupFiles', ['a', 2]],
      ['setupFilesAfterEnv', undefined],
      ['loader', 'x'],
      ['loader.extensions', undefined],
      ['loader.conditions', [1]],
      ['loader.tsconfig', true],
      ['loader.mappers', {}],
      ['loader.typescript', 'tsc'],
    ]
    for (const [path, value] of cases) {
      assert.throws(
        () => parseProjectConfig(with_(path, value)),
        (error: unknown) =>
          error instanceof WorkerError &&
          error.code === 'ORCH_BAD_CONFIG' &&
          error.message.includes(path.split('.').slice(0, 2).join('.')),
        path,
      )
    }
  })

  it('rejects a config that is not an object', () => {
    for (const value of [undefined, null, 'config', 3, []]) {
      assert.throws(() => parseProjectConfig(value), { code: 'ORCH_BAD_CONFIG' })
    }
  })
})
