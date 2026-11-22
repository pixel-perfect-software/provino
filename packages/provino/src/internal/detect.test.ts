import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JEST_CONFIG_CANDIDATES } from '@provino/dialect-jest/node'
import { JEST_CONFIG_FILES } from './detect.ts'

test("JEST_CONFIG_FILES is the Jest dialect's candidate list without package.json", () => {
  assert.deepEqual(
    JEST_CONFIG_FILES,
    JEST_CONFIG_CANDIDATES.filter((name) => name !== 'package.json'),
  )
})
