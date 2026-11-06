import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HoistPolicy } from '@provino/types'
import { defineDialect, defineHoistPolicy } from './dialect.ts'

test('defineDialect returns the dialect it is given', () => {
  const dialect = {
    name: 'acme',
    version: '1.0',
    policy: { core: { nameSeparator: '/' } },
  } as const
  assert.equal(defineDialect(dialect), dialect)
})

test('defineHoistPolicy returns the policy it is given', () => {
  const policy: HoistPolicy<'mock', never> = {
    id: 'acme',
    objects: [{ kind: 'global', name: 'acme' }],
    hoistCalls: { mock: 'any' },
    hoistValues: [],
    rewriteImportArg: [],
    chainable: false,
    placement: 'enclosing-block',
    topLevelGuards: [],
    factoryReferences: 'allow',
    runnerModules: [],
    reExports: 'in-order',
    messages: {
      HOIST_FACTORY_OUT_OF_SCOPE: 'a',
      HOIST_NOT_TOP_LEVEL: 'b',
      HOIST_NESTED: 'c',
      HOIST_EXPORTED: 'd',
      HOIST_FACTORY_NOT_FUNCTION: 'e',
    },
  }
  assert.equal(defineHoistPolicy(policy), policy)
})
