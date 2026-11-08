import assert from 'node:assert/strict'
import { test } from 'node:test'
import { vitestDialect } from '@provino/dialect-vitest'
import { vitestNodeDialect } from './index.ts'

test('the coordinator entry hands back the dialect value until the config reader exists', () => {
  assert.equal(vitestNodeDialect, vitestDialect)
  assert.equal(vitestNodeDialect.configReader, undefined)
})
