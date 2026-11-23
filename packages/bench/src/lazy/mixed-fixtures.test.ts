// T6.9: one file that mixes `test.extend` fixtures and lazy values, on the real `@provino/core`
// with `@provino/lazy` over its `LazyHost`, under the neutral policy (`definitions.extendApi:
// 'expose'`). Provino's own: Jest has no fixtures and Vitest no lazy values, so no runner records it.
// Lazy entries live in the suite tables core owns (`LazyHost.definitions`, D106).
import assert from 'node:assert/strict'
import type { FixtureTestApi } from '@provino/core'
import { neutralPolicy } from '@provino/policy'
import { test } from 'provino'
import { runFile } from './run.ts'

type Use<V> = (value: V) => Promise<void>

test('a test of an extended test reads its fixtures and the lazy values of its suite', async () => {
  const seen: string[] = []
  let tableKeys: string[] = []
  let kinds: string[] = []
  const result = await runFile(neutralPolicy, ({ api, lazy, runtime, step }) => {
    const it = (api.test as FixtureTestApi).extend<{ db: { rows: string[] } }>({
      db: async ({ task: _task }, use: Use<{ rows: string[] }>) => {
        step('db up')
        await use({ rows: [] })
        step('db down')
      },
    })
    const $ = lazy.let('user', () => {
      step('user made')
      return 'ada'
    })
    const root = runtime.lazyHost.collecting()
    if (root !== undefined) {
      const table = runtime.lazyHost.definitions(root)
      tableKeys = [...table.keys()]
      kinds = [...table.values()].map((entry) => entry.kind)
    }
    api.describe('nested', () => {
      $.override('user', () => 'grace')
      it('reads both', ({ db }) => {
        db.rows.push($.user)
        seen.push(db.rows.join(','))
      })
    })
    it('reads both at the top', ({ db }) => {
      db.rows.push($.user)
      seen.push(db.rows.join(','))
    })
  })
  assert.deepEqual(
    result.fileErrors.flat().map((error) => error.message),
    [],
  )
  assert.deepEqual(Object.values(result.states), ['pass', 'pass'])
  assert.deepEqual(seen, ['grace', 'ada'])
  assert.deepEqual(result.trace, ['db up', 'db down', 'db up', 'user made', 'db down'])
  assert.deepEqual(tableKeys, ['user'])
  assert.deepEqual(kinds, ['lazy'])
})
