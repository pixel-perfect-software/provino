// T7.12: `jest-matcher-utils`, `jest-message-util` and `jest-util` load when a message is first
// printed, not when the dialect's runtime is imported, and what they print is what the packages
// themselves print.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as matcherUtilsNamespace from 'jest-matcher-utils'
import * as messageUtilNamespace from 'jest-message-util'
import * as jestUtilNamespace from 'jest-util'
import * as lazy from './vendor/jest-expect/lazy-jest-packages.ts'

const require = createRequire(import.meta.url)
const RUNTIME = fileURLToPath(new URL('./index.ts', import.meta.url))
const FACADE = fileURLToPath(new URL('./vendor/jest-expect/lazy-jest-packages.ts', import.meta.url))
const DIALECT = fileURLToPath(new URL('../dialect.ts', import.meta.url))
const EXPECT_POLICY = fileURLToPath(new URL('../expect-policy.ts', import.meta.url))

/**
 * Runs `code` as a module in a fresh process started in this package, and returns the JSON on the
 * last line it prints. `facade` imports the facade first, as the worker's boot does (as `lazy`,
 * with `fs`); `env` is set for the process, and neither FORCE_COLOR nor NO_COLOR is inherited.
 */
function fresh(
  code: string,
  options: { readonly facade?: boolean; readonly env?: NodeJS.ProcessEnv } = {},
): unknown {
  const { FORCE_COLOR: _color, NO_COLOR: _noColor, ...inherited } = process.env
  const script = [
    ...(options.facade
      ? [
          `const lazy = await import(${JSON.stringify(FACADE)})`,
          "const { createRequire } = await import('node:module')",
          "const fs = createRequire(import.meta.url)('node:fs')",
        ]
      : []),
    code,
  ].join('\n')
  const result = spawnSync(
    process.execPath,
    ['--conditions=provino-source', '--input-type=module', '-e', script],
    {
      encoding: 'utf8',
      env: { ...inherited, ...options.env },
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
    },
  )
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? 'null')
}

/** Which of the three packages a fresh process has loaded after `code`, by `require.cache`. */
function loadedAfter(code: string): readonly string[] {
  return fresh(`${code}
    const { createRequire: req } = await import('node:module')
    const cache = Object.keys(req(process.cwd() + '/x.js').cache)
    console.log(JSON.stringify(['jest-matcher-utils', 'jest-message-util', 'jest-util'].filter(
      (name) => cache.some((file) => file.includes('/node_modules/' + name + '/build/')),
    )))`) as string[]
}
describe('the Jest dialect runtime loads Jest message packages on first use (T7.12)', () => {
  test('importing the runtime, and building its table, loads none of them', () => {
    assert.deepEqual(
      loadedAfter(`
        const runtime = await import(${JSON.stringify(RUNTIME)})
        const table = runtime.jestExpectTable()
        void table
      `),
      [],
    )
  })

  test('printing a message loads the package that prints it, and only that one', () => {
    assert.deepEqual(
      loadedAfter(`
        const lazy = await import(${JSON.stringify(FACADE)})
        lazy.matcherHint('toBe')
      `),
      ['jest-matcher-utils'],
    )
    assert.deepEqual(
      loadedAfter(`
        const lazy = await import(${JSON.stringify(FACADE)})
        lazy.pluralize('digit', 2)
      `),
      ['jest-util'],
    )
    assert.deepEqual(
      loadedAfter(`
        const lazy = await import(${JSON.stringify(FACADE)})
        lazy.formatStackTrace('at x (/a.js:1:1)', { rootDir: '/', testMatch: [] }, { noStackTrace: false })
      `),
      // jest-message-util itself depends on jest-util.
      ['jest-message-util', 'jest-util'],
    )
  })
})

/**
 * A worker's `expect` over the Jest dialect's table, as the worker builds it, and then `body`:
 * assertions against it (`mk()` makes a mock function under the Jest mock policy).
 */
function withExpect(body: string): string {
  return `
    const { currentTest } = await import('@provino/core')
    const { createExpect, createMatcherRegistry, createStateSource, installMatchersSlot } = await import('@provino/expect')
    const { neutralPolicy, resolvePolicy } = await import('@provino/policy')
    const { createMockFn, createMockRegistry } = await import('@provino/mock')
    const { jestPolicy } = await import(${JSON.stringify(DIALECT)})
    const { jestExpectPolicy } = await import(${JSON.stringify(EXPECT_POLICY)})
    const { jestExpectTable } = await import(${JSON.stringify(RUNTIME)})
    const source = createStateSource(currentTest, {
      nameSeparator: neutralPolicy.core.nameSeparator,
      expand: jestExpectPolicy.expand,
    })
    const registry = createMatcherRegistry()
    installMatchersSlot(source, registry)
    const expect = createExpect({ policy: jestExpectPolicy, table: jestExpectTable(), source, registry })
    const mockPolicy = resolvePolicy(jestPolicy).mock
    const mk = () => createMockFn(mockPolicy, createMockRegistry())
    ${body}`
}

/** Assertions that pass, and so print nothing: the ones the `ensure*` checks sit in front of. */
const PASSING = `
  expect(1).toBe(1)
  expect({ a: 1 }).toEqual({ a: 1 })
  expect(1).toBeDefined()
  expect(undefined).not.toBeDefined()
  expect(1).toBeTruthy()
  expect(0).not.toBeTruthy()
  expect(null).toBeNull()
  expect(2).toBeGreaterThan(1)
  expect(1n).toBeLessThanOrEqual(1n)
  expect([1]).toHaveLength(1)
  expect([1]).toContain(1)
  expect('a').toMatch(/a/)
  expect(() => { throw new Error('x') }).toThrow('x')
  const called = mk(); called()
  expect(called).toHaveBeenCalled()
  expect(called).toHaveBeenCalledTimes(1)
  expect(called).toHaveReturned()
  expect(called).toHaveReturnedTimes(1)
  expect(mk()).not.toHaveBeenCalled()
`

describe('a worker whose assertions pass never loads jest-matcher-utils (T7.12)', () => {
  test('the passing assertions of a typical file load none of the three packages', () => {
    assert.deepEqual(loadedAfter(withExpect(PASSING)), [])
  })

  test('and a failing one loads jest-matcher-utils, which prints its message', () => {
    assert.deepEqual(
      loadedAfter(withExpect(`${PASSING}\n try { expect(1).toBe(2) } catch {}`)).includes(
        'jest-matcher-utils',
      ),
      true,
    )
  })
})

/** What a call does: `undefined` when it returns, else the message it throws. */
function outcome(call: () => void): string | undefined {
  try {
    call()
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe('each ensure* stand-in throws exactly when jest-matcher-utils does, with its message', () => {
  const hint = [
    undefined,
    { isNot: true, promise: 'rejects' as const },
    { isNot: false, promise: '' as const },
  ]
  const real = matcherUtilsNamespace

  test('ensureNoExpected: only an expected argument is refused', () => {
    const values: unknown[] = [undefined, null, 0, '', false, 1, 'x', {}, [], NaN, 1n]
    let refused = 0
    for (const options of hint) {
      for (const value of values) {
        const mine = outcome(() => lazy.ensureNoExpected(value, 'toBeDefined', options))
        assert.equal(
          mine,
          outcome(() => real.ensureNoExpected(value, 'toBeDefined', options)),
        )
        if (mine !== undefined) refused++
      }
    }
    assert.equal(refused, 3 * 10)
  })

  test('ensureNumbers: both must be a number (any, NaN and Infinity too) or a bigint', () => {
    const values: unknown[] = [0, 1, -1, NaN, Infinity, 1n, '1', undefined, null, {}, [], true]
    let refused = 0
    let accepted = 0
    for (const options of hint) {
      for (const actual of values) {
        for (const expected of values) {
          const mine = outcome(() =>
            lazy.ensureNumbers(actual, expected, 'toBeGreaterThan', options),
          )
          assert.equal(
            mine,
            outcome(() => real.ensureNumbers(actual, expected, 'toBeGreaterThan', options)),
            `${String(actual)}, ${String(expected)}`,
          )
          if (mine === undefined) accepted++
          else refused++
        }
      }
    }
    assert.ok(accepted > 0 && refused > 0, `${accepted} accepted, ${refused} refused`)
  })

  test('ensureExpectedIsNonNegativeInteger: a safe integer, zero or more, and a number', () => {
    const values: unknown[] = [
      0,
      -0,
      1,
      2 ** 53 - 1,
      2 ** 53,
      -1,
      1.5,
      NaN,
      Infinity,
      -Infinity,
      1n,
      '1',
      undefined,
      null,
      {},
    ]
    let refused = 0
    let accepted = 0
    for (const options of hint) {
      for (const value of values) {
        const mine = outcome(() =>
          lazy.ensureExpectedIsNonNegativeInteger(value, 'toHaveLength', options),
        )
        assert.equal(
          mine,
          outcome(() => real.ensureExpectedIsNonNegativeInteger(value, 'toHaveLength', options)),
          String(value),
        )
        if (mine === undefined) accepted++
        else refused++
      }
    }
    assert.ok(accepted > 0 && refused > 0, `${accepted} accepted, ${refused} refused`)
  })
})

describe('the stand-ins print what the packages print', () => {
  test('every function the dialect imports gives the real result', () => {
    const real = matcherUtilsNamespace
    assert.equal(
      lazy.matcherHint('toBe', 'received', 'expected'),
      real.matcherHint('toBe', 'received', 'expected'),
    )
    assert.equal(lazy.printReceived({ a: [1, 'x'] }), real.printReceived({ a: [1, 'x'] }))
    assert.equal(lazy.printExpected(/re/g), real.printExpected(/re/g))
    assert.equal(lazy.stringify({ a: new Map([[1, 2]]) }), real.stringify({ a: new Map([[1, 2]]) }))
    assert.equal(
      lazy.printDiffOrStringify({ a: 1 }, { a: 2 }, 'Expected', 'Received', true),
      real.printDiffOrStringify({ a: 1 }, { a: 2 }, 'Expected', 'Received', true),
    )
    assert.equal(lazy.diff('a\nb', 'a\nc'), real.diff('a\nb', 'a\nc'))
    assert.equal(
      lazy.matcherErrorMessage('hint', 'generic', 'specific'),
      real.matcherErrorMessage('hint', 'generic', 'specific'),
    )
    assert.equal(
      lazy.printWithType('Received', 5, real.printReceived),
      real.printWithType('Received', 5, real.printReceived),
    )
    assert.equal(
      lazy.getLabelPrinter('Expected', 'Received')('Received'),
      real.getLabelPrinter('Expected', 'Received')('Received'),
    )
    assert.equal(lazy.pluralize('digit', 2), jestUtilNamespace.pluralize('digit', 2))
    assert.equal(lazy.suggestToContainEqual(), real.SUGGEST_TO_CONTAIN_EQUAL)
    const stack = 'Error: boom\n    at f (/a/b.js:1:2)'
    assert.deepEqual(
      lazy.separateMessageFromStack(stack),
      messageUtilNamespace.separateMessageFromStack(stack),
    )
  })

  test('the colour functions are called, and carry .bold and the rest, as Chalk does', () => {
    const real = matcherUtilsNamespace
    const pairs: [string, (text: string) => string, (text: string) => string][] = [
      ['BOLD_WEIGHT', lazy.BOLD_WEIGHT, real.BOLD_WEIGHT],
      ['DIM_COLOR', lazy.DIM_COLOR, real.DIM_COLOR],
      ['EXPECTED_COLOR', lazy.EXPECTED_COLOR, real.EXPECTED_COLOR],
      ['INVERTED_COLOR', lazy.INVERTED_COLOR, real.INVERTED_COLOR],
      ['RECEIVED_COLOR', lazy.RECEIVED_COLOR, real.RECEIVED_COLOR],
    ]
    for (const [name, standIn, actual] of pairs) assert.equal(standIn('text'), actual('text'), name)
    assert.equal(lazy.RECEIVED_COLOR.bold('text'), real.RECEIVED_COLOR.bold('text'))
    assert.equal(typeof lazy.RECEIVED_COLOR.bold, 'function')
    assert.ok('bold' in lazy.RECEIVED_COLOR)
  })

  test('matcherUtilsNamespace reads like `import * as`', () => {
    assert.equal(
      lazy.matcherUtilsNamespace.matcherHint('toBe'),
      matcherUtilsNamespace.matcherHint('toBe'),
    )
    assert.equal(
      lazy.matcherUtilsNamespace.SUGGEST_TO_CONTAIN_EQUAL,
      matcherUtilsNamespace.SUGGEST_TO_CONTAIN_EQUAL,
    )
  })

  test('`this.utils` has the keys, order and values of the namespace spread it replaces', () => {
    const extra = { iterableEquality: () => true, subsetEquality: () => false }
    const expected = { ...matcherUtilsNamespace, ...extra }
    for (const freeze of [false, true]) {
      const utils = lazy.lazyUtils(extra, freeze)
      assert.deepEqual(Object.keys(utils), Object.keys(expected), `freeze ${freeze}`)
      assert.deepEqual({ ...utils }, expected, `freeze ${freeze}`)
      assert.equal(utils.matcherHint, matcherUtilsNamespace.matcherHint)
      assert.equal(utils.iterableEquality, extra.iterableEquality)
      // A write is refused when the original was frozen (a proxy can't report itself frozen).
      assert.equal(Reflect.set(utils, 'probe', 1), !freeze)
      assert.ok('printReceived' in utils)
      assert.ok(!('nope' in utils))
    }
  })

  test('the frozen `utils` of the asymmetric matchers refuses a write, as Object.freeze did', () => {
    const frozen = lazy.lazyUtils({}, true) as Record<string, unknown>
    assert.throws(() => {
      frozen.matcherHint = 1
    }, TypeError)
    const open = lazy.lazyUtils({}, false) as Record<string, unknown>
    open.added = 1
    assert.equal((open as { added: number }).added, 1)
  })

  test('is the same package at the same version the dialect pins', () => {
    for (const name of ['jest-matcher-utils', 'jest-message-util', 'jest-util']) {
      const resolved = require.resolve(name)
      const viaImport = fileURLToPath(import.meta.resolve(name))
      assert.ok(
        viaImport.includes(`/node_modules/${name}/`) && resolved.includes(`/node_modules/${name}/`),
        name,
      )
    }
  })
})

describe('what the packages do when they first load happens at boot, as it did when imported (T7.12)', () => {
  const colourAfterChange = [
    'process.env.FORCE_COLOR = process.env.AFTER',
    "console.log(JSON.stringify({ coloured: lazy.RECEIVED_COLOR('x').includes('\\u001b[') }))",
  ].join('\n')

  test("the colour level Chalk reads from FORCE_COLOR and the terminal is the boot one: a test can't change the first failure's", () => {
    // Booted with colours off (not a terminal), a test turns them on: the first failure is plain.
    assert.deepEqual(fresh(colourAfterChange, { facade: true, env: { AFTER: '1' } }), {
      coloured: false,
    })
    // Booted with colours on, a test turns them off: the first failure is still coloured.
    assert.deepEqual(
      fresh(colourAfterChange, {
        facade: true,
        env: { FORCE_COLOR: '1', AFTER: '0' },
      }),
      {
        coloured: true,
      },
    )
  })

  test("the colour support picocolors (Babel's code frame) reads from NO_COLOR is the boot one", () => {
    const code = [
      "process.env.NO_COLOR = '1'",
      "const babel = createRequire(createRequire(import.meta.url).resolve('jest-message-util')).resolve('@babel/code-frame')",
      "console.log(JSON.stringify({ supported: createRequire(babel)('picocolors').isColorSupported }))",
    ].join('\n')
    assert.deepEqual(fresh(code, { facade: true, env: { FORCE_COLOR: '1' } }), { supported: true })
  })

  test('graceful-fs has patched fs.closeSync and process.cwd before a test can spy on them', () => {
    const code = [
      'const spy = () => {}',
      'fs.closeSync = spy',
      'const cwd = process.cwd',
      '// The first message that needs jest-message-util must not patch fs again around the spy.',
      "lazy.separateMessageFromStack('Error: x\\n    at f (/a.js:1:1)')",
      'console.log(JSON.stringify({ spyKept: fs.closeSync === spy, cwdKept: process.cwd === cwd }))',
    ].join('\n')
    assert.deepEqual(fresh(code, { facade: true }), { spyKept: true, cwdKept: true })
  })
})
