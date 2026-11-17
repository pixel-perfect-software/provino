import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { UsageError } from './usage-error.ts'
import { hasViews, viewsNeedProvino, viewsOf } from './views.ts'

describe('the views a pair of flags asks for', () => {
  it('viewsOf is the options of a provino choice: only what is on, nothing when neither is', () => {
    assert.deepEqual(viewsOf(true, undefined), { tree: true })
    assert.deepEqual(viewsOf(undefined, true), { map: true })
    assert.deepEqual(viewsOf(true, true), { tree: true, map: true })
    assert.deepEqual(viewsOf(false, false), {})
    assert.deepEqual(viewsOf(undefined, undefined), {})
  })

  it('hasViews says whether any is on', () => {
    assert.equal(hasViews({}), false)
    assert.equal(hasViews({ tree: true }), true)
    assert.equal(hasViews({ map: true }), true)
    assert.equal(hasViews(viewsOf(true, true)), true)
  })

  it('viewsNeedProvino names the flags, in the usage error both commands share', () => {
    for (const [views, message] of [
      [{ tree: true as const }, '--tree needs the provino reporter'],
      [{ map: true as const }, '--map needs the provino reporter'],
      [{ tree: true as const, map: true as const }, '--tree and --map need the provino reporter'],
    ] as const) {
      const error = viewsNeedProvino(views)
      assert.ok(error instanceof UsageError)
      assert.equal(error.code, 'PROVINO_USAGE')
      assert.equal(error.message, message)
    }
  })
})
