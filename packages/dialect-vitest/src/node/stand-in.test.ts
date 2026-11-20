import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as realConfig from 'vitest/config'
import {
  defaultExclude,
  defaultInclude,
  coverageConfigDefaults as standInCoverage,
  configDefaults as standInDefaults,
} from './vitest-config-stand-in.ts'

// B25c: the stand-in `vitest/config` serves these as data, so a version bump that moves one fails.
test("the stand-in's configDefaults and coverageConfigDefaults are vitest/config 5.0.5's", () => {
  const environmentDependent = ['allowOnly', 'watch', 'open', 'reporters']
  const strip = (value: object): object =>
    Object.fromEntries(Object.entries(value).filter(([key]) => !environmentDependent.includes(key)))
  assert.deepEqual(strip(standInDefaults), strip(realConfig.configDefaults))
  assert.deepEqual(standInCoverage, realConfig.coverageConfigDefaults)
  assert.deepEqual(defaultInclude, realConfig.defaultInclude)
  assert.deepEqual(defaultExclude, realConfig.defaultExclude)
  assert.ok(Object.isFrozen(standInDefaults))
})
