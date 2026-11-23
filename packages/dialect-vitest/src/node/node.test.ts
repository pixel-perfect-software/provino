import assert from 'node:assert/strict'
import { vitestDialect } from '@provino/dialect-vitest'
import { test } from 'provino'
import { vitestConfigReader, vitestNodeDialect } from './index.ts'

test('the coordinator entry is the dialect value plus the config reader', () => {
  assert.equal(vitestNodeDialect.name, vitestDialect.name)
  assert.equal(vitestNodeDialect.policy, vitestDialect.policy)
  assert.equal(vitestNodeDialect.configReader, vitestConfigReader)
  assert.equal(vitestDialect.configReader, undefined)
})
