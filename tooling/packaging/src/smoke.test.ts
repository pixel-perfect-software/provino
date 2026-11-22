// The native case of `pnpm smoke:install` (B27e, acceptance row 9): its tree check, its project,
// and that it runs by default since B27f's install split (D187).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  bannedInTree,
  NATIVE_SMOKE_FILES,
  nativeBanned,
  SMOKE_FILES,
  SMOKE_TESTS,
} from './smoke.ts'
import { ROOT } from './workspace.ts'

/** The real manifest's native list. */
const BANNED = nativeBanned(ROOT)

/** A `pnpm ls --json` tree: one project depending on `provino`, which depends on `deps`. */
const treeOf = (deps: readonly string[]): unknown => [
  {
    name: 'provino-native-smoke',
    dependencies: {
      provino: {
        version: '0.1.0',
        dependencies: Object.fromEntries(
          deps.map((name) => [name, { version: '1.0.0', dependencies: {} }]),
        ),
      },
    },
  },
]

describe('bannedInTree', () => {
  test('a tree with only Provino and its own packages has none', () => {
    assert.deepEqual(
      bannedInTree(treeOf(['oxc-parser', 'tinyglobby', '@sinonjs/fake-timers']), BANNED),
      [],
    )
  })

  test('each family of the native list is found, however deep, once each and sorted', () => {
    const deep = treeOf(['magic-string'])
    const provino = (
      deep as [{ dependencies: { provino: { dependencies: Record<string, unknown> } } }]
    )[0].dependencies.provino
    provino.dependencies['magic-string'] = {
      version: '1',
      dependencies: { 'pretty-format': { version: '30' }, chai: { version: '5' } },
    }
    assert.deepEqual(bannedInTree(deep, BANNED), ['chai', 'pretty-format'])
    assert.deepEqual(
      bannedInTree(
        treeOf([
          'jest-util',
          '@jest/get-type',
          'expect',
          '@vitest/expect',
          'vite',
          '@babel/core',
          'jest-util',
        ]),
        BANNED,
      ),
      ['@babel/core', '@jest/get-type', '@vitest/expect', 'expect', 'jest-util', 'vite'],
    )
  })

  test('names that only look alike pass', () => {
    assert.deepEqual(
      bannedInTree(treeOf(['expect-type', 'vitest-x', 'jestish', 'babel-core']), BANNED),
      [],
    )
  })

  test('what is not a tree is skipped', () => {
    assert.deepEqual(bannedInTree(null, BANNED), [])
    assert.deepEqual(bannedInTree([{ dependencies: 'x' }], BANNED), [])
  })
})

describe('nativeBanned', () => {
  test("is the manifest's native set: each family, and look-alikes pass", () => {
    for (const name of [
      'jest-util',
      '@jest/get-type',
      'expect',
      'pretty-format',
      'chai',
      '@vitest/expect',
      'vite',
      '@babel/core',
    ]) {
      assert.match(name, BANNED)
    }
    for (const name of ['expect-type', 'vitest', 'babel-core', 'jest'])
      assert.doesNotMatch(name, BANNED)
  })
})

describe('the native footprint case', () => {
  test('both suites hold SMOKE_TESTS tests', () => {
    assert.equal(Object.keys(SMOKE_FILES).length, SMOKE_TESTS)
  })

  test('its project names no dialect and imports the native API from provino', () => {
    assert.doesNotMatch(NATIVE_SMOKE_FILES['provino.config.ts'] ?? '', /dialect/)
    assert.match(NATIVE_SMOKE_FILES['native.test.ts'] ?? '', /from 'provino'/)
    assert.equal(
      (NATIVE_SMOKE_FILES['native.test.ts'] ?? '').match(/\b(?:it|test)\('/g)?.length,
      SMOKE_TESTS,
    )
  })
})
