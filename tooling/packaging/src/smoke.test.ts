// The native case of `pnpm smoke:install` (B27e, acceptance row 9): its tree check, its project,
// and that it stays skipped, citing B27f, until the install split lands.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { bannedInTree, NATIVE_SMOKE_FILES } from './smoke.ts'

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
    assert.deepEqual(bannedInTree(treeOf(['oxc-parser', 'tinyglobby', '@sinonjs/fake-timers'])), [])
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
    assert.deepEqual(bannedInTree(deep), ['chai', 'pretty-format'])
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
      ),
      ['@babel/core', '@jest/get-type', '@vitest/expect', 'expect', 'jest-util', 'vite'],
    )
  })

  test('names that only look alike pass', () => {
    assert.deepEqual(bannedInTree(treeOf(['expect-type', 'vitest-x', 'jestish', 'babel-core'])), [])
  })

  test('what is not a tree is skipped', () => {
    assert.deepEqual(bannedInTree(null), [])
    assert.deepEqual(bannedInTree([{ dependencies: 'x' }]), [])
  })
})

describe('the native footprint case', () => {
  test('its project names no dialect and imports the native API from provino', () => {
    assert.doesNotMatch(NATIVE_SMOKE_FILES['provino.config.ts'] ?? '', /dialect/)
    assert.match(NATIVE_SMOKE_FILES['native.test.ts'] ?? '', /from 'provino'/)
    assert.equal((NATIVE_SMOKE_FILES['native.test.ts'] ?? '').match(/\b(?:it|test)\('/g)?.length, 3)
  })
})
