import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defineDialect } from './dialect.ts'

test('defineDialect returns the dialect it is given', () => {
  const dialect = {
    name: 'acme',
    version: '1.0',
    policy: { core: { nameSeparator: '/' } },
  } as const
  assert.equal(defineDialect(dialect), dialect)
})
