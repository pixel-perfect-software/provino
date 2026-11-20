import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { GlobalsHost } from '@provino/types'
import { ApiError, provinoGlobals, provinoModuleScope } from './index.ts'

// The stubs take no host apart; the cast stands in for the worker's.
const host = {} as GlobalsHost

describe('the scaffold', () => {
  test('each factory throws API_NOT_BUILT, naming itself', () => {
    for (const [name, factory] of [
      ['provinoModuleScope', provinoModuleScope],
      ['provinoGlobals', provinoGlobals],
    ] as const) {
      assert.throws(
        () => factory(host),
        (error: unknown) =>
          error instanceof ApiError &&
          error.code === 'API_NOT_BUILT' &&
          error.name === 'ApiError' &&
          error.message.includes(name),
      )
    }
  })
})
