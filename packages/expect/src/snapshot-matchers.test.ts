import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { iterableEquality, subsetEquality } from '@jest/expect-utils'
import { SnapshotError, SnapshotState } from '@provino/snapshot/runtime'
import type { ExpectStatic, SnapshotMessageInfo, SnapshotPrinter } from '@provino/types'
import { createEndOfTest } from './end-of-test.ts'
import { createExpect, MatcherResultError } from './expect.ts'
import { manualCurrentTest, testPolicy, testTable, testTask } from './internal/test-support.ts'
import { createMatcherRegistry } from './slot.ts'
import { snapshotMatchers } from './snapshot-matchers.ts'
import { createStateSource, type StateSource } from './state.ts'

const HEADER = '// Test Snapshot v1'

/** A printer that needs no dialect: a serializer that matches first, else `JSON.stringify`. */
const printer: SnapshotPrinter = {
  serialize: (value, { plugins }) => {
    const MARK = '@@plugin@@'
    const text =
      JSON.stringify(
        value,
        (_key, item: unknown) => {
          const plugin = plugins.find((candidate) => candidate.test(item))
          if (plugin !== undefined && 'serialize' in plugin) {
            return `${MARK}${(plugin.serialize as (v: unknown) => string)(item)}`
          }
          return item instanceof Error ? `${MARK}[${item.name}: ${item.message}]` : item
        },
        2,
      ) ?? 'undefined'
    return text.replaceAll(new RegExp(`"${MARK}([^"]*)"`, 'g'), '$1')
  },
  messages: {
    mismatch: (info: SnapshotMessageInfo) =>
      `mismatch ${info.key}|${info.currentTestName}|${info.hint}|${info.expected}|${info.actual}`,
    notWritten: (info) => `not written ${info.key}|${info.actual}`,
    propertiesMismatch: (info) => `properties ${info.key}`,
  },
}

interface Options {
  /** The `.snap` text on disk before the file runs. */
  stored?: string
  update?: 'all' | 'new' | 'none'
  fileSnapshot?: boolean
  /** `ExpectPolicy.soft`: `expect.soft` exists (T7.8). */
  soft?: boolean
  throwErrorBody?: 'message' | 'error'
  keyJoin?: string
  hintJoin?: string
  /** The policy has an inline snapshot writer (B23d B1). */
  inlineWrites?: boolean
}

interface Setup {
  readonly expect: ExpectStatic
  readonly source: StateSource
  readonly dir: string
  readonly state: SnapshotState
  readonly snapPath: string
  /**
   * Runs `fn` as the test with this title path, then the end-of-test check the runtime runs: the
   * first error the test held back (`dontThrow`, `expect.soft`) is thrown, as it fails the test.
   */
  inTest<T>(titlePath: string[], fn: () => T, id?: string): T
  /** Runs `fn` as the test with this title path and nothing else: held errors stay held. */
  inRawTest<T>(titlePath: string[], fn: () => T, id?: string): T
}

const isThenable = (value: unknown): value is Promise<unknown> =>
  typeof value === 'object' && value !== null && typeof Reflect.get(value, 'then') === 'function'

const put = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function setup(options: Options = {}): Setup {
  const dir = mkdtempSync(join(tmpdir(), 'provino-expect-snapshot-'))
  after(() => rmSync(dir, { recursive: true, force: true }))
  const keyJoin = options.keyJoin ?? ' '
  const current = manualCurrentTest()
  const source = createStateSource(current, { nameSeparator: keyJoin, expand: false })
  source.startFile(join(dir, 'a.test.ts'))
  const base = testTable()
  const snapshot = snapshotMatchers({ fileSnapshot: options.fileSnapshot ?? false })
  const expect = createExpect({
    policy: { ...testPolicy, soft: options.soft ?? false },
    table: {
      ...base,
      matchers: { ...base.matchers, ...snapshot.matchers },
      promiseMatchers: { ...base.promiseMatchers, ...snapshot.promiseMatchers },
      utils: { iterableEquality, subsetEquality },
    },
    source,
    registry: createMatcherRegistry(),
  })
  const snapPath = join(dir, '__snapshots__', 'a.test.ts.snap')
  if (options.stored !== undefined) put(snapPath, options.stored)
  const state = new SnapshotState({
    testPath: join(dir, 'a.test.ts'),
    snapshotPath: snapPath,
    update: options.update ?? 'new',
    expand: false,
    policy: {
      header: HEADER,
      keyJoin,
      hintJoin: options.hintJoin ?? ': ',
      throwErrorBody: options.throwErrorBody ?? 'message',
      format: { escapeString: false, printBasicPrototype: false, maxOutputLength: null, extra: {} },
    },
    key: (name, count) => `${name} ${count}`,
    printer,
    inlineWrites: options.inlineWrites ?? false,
  })
  expect.setState({ snapshotState: state })
  function inRawTest<T>(titlePath: string[], fn: () => T, id = titlePath.join('/')): T {
    current.enter(testTask(id, titlePath))
    try {
      return fn()
    } finally {
      current.enter(null)
    }
  }
  return {
    expect,
    source,
    dir,
    state,
    snapPath,
    inRawTest,
    inTest(titlePath, fn, id = titlePath.join('/')) {
      const endOfTest = createEndOfTest({
        source,
        messages: base.messages,
        policy: { requireAssertions: false },
        hasAssertionsWhenFailed: 'skip',
      })
      const check = () => {
        const [first] = endOfTest({ test: { id }, attempt: 0, repeat: 0, failed: false })
        if (first !== undefined) throw first
      }
      const result = inRawTest(titlePath, fn, id)
      if (isThenable(result)) {
        return result.then((value) => {
          check()
          return value
        }) as typeof result
      }
      check()
      return result
    },
  }
}

/** A matcher the types don't list, or called with arguments they don't allow, as user code does. */
type Loose = Record<
  'toMatchSnapshot' | 'toThrowErrorMatchingInlineSnapshot' | 'toMatchFileSnapshot',
  (...args: unknown[]) => unknown
>
const loose = (value: unknown): Loose => value as Loose

describe('toMatchSnapshot', () => {
  test('writes a new snapshot named for the test, then finds it again', () => {
    const first = setup()
    first.inTest(['outer', 'inner'], () => first.expect({ a: 1 }).toMatchSnapshot())
    first.state.finish()
    const written = readFileSync(first.snapPath, 'utf8')
    assert.match(written, /exports\[`outer inner 1`\] = `\n\{\n {2}"a": 1\n\}\n`;/)

    const second = setup({ update: 'none', stored: written })
    second.inTest(['outer', 'inner'], () => second.expect({ a: 1 }).toMatchSnapshot())
    assert.equal(second.state.matched, 1)
  })

  test('the hint joins with the policy`s join, and the title path with the key join', () => {
    const jest = setup()
    jest.inTest(['a', 'b'], () => jest.expect(1).toMatchSnapshot('the hint'))
    jest.state.finish()
    assert.match(readFileSync(jest.snapPath, 'utf8'), /exports\[`a b: the hint 1`\]/)

    const vitest = setup({ keyJoin: ' > ', hintJoin: ' > ' })
    vitest.inTest(['a', 'b'], () => vitest.expect(1).toMatchSnapshot('the hint'))
    vitest.state.finish()
    assert.match(readFileSync(vitest.snapPath, 'utf8'), /exports\[`a > b > the hint 1`\]/)
  })

  test('a missing snapshot under `none` throws the dialect`s not-written message', () => {
    const { expect, inTest } = setup({ update: 'none' })
    assert.throws(() => inTest(['t'], () => expect(2).toMatchSnapshot('h')), {
      message: 'not written t: h 1|2',
    })
  })

  test('a mismatch throws the dialect`s message with the name, hint and both sides', () => {
    const { expect, inTest } = setup({
      update: 'none',
      stored: `${HEADER}\n\nexports[\`t: h 1\`] = \`1\`;\n`,
    })
    assert.throws(() => inTest(['t'], () => expect(2).toMatchSnapshot('h')), {
      message: 'mismatch t: h 1|t|h|1|2',
    })
  })

  test('a mismatch carries actual and expected on the error`s result', () => {
    const { expect, inTest } = setup({
      update: 'none',
      stored: `${HEADER}\n\nexports[\`t 1\`] = \`1\`;\n`,
    })
    try {
      inTest(['t'], () => expect(2).toMatchSnapshot())
      assert.fail('expected a mismatch')
    } catch (error) {
      const result = (error as { matcherResult?: Record<string, unknown> }).matcherResult
      assert.equal(result?.actual, '2')
      assert.equal(result?.expected, '1')
      assert.equal(result?.name, 'toMatchSnapshot')
    }
  })

  test('property matchers merge into the received value before it is serialized', () => {
    const { expect, inTest, state, snapPath } = setup()
    expect.addSnapshotSerializer({
      test: (value) =>
        typeof value === 'object' &&
        value !== null &&
        Reflect.get(value, '$$typeof') === Symbol.for('jest.asymmetricMatcher'),
      serialize: () => 'Anything',
    })
    inTest(['t'], () => expect({ id: 7, name: 'x' }).toMatchSnapshot({ id: expect.anything() }))
    state.finish()
    const text = readFileSync(snapPath, 'utf8')
    assert.match(text, /"id": Anything/)
    assert.match(text, /"name": "x"/)
  })

  test('property matchers that don`t match fail, and the key`s number moves on', () => {
    const { expect, inTest, state, snapPath } = setup()
    assert.throws(() => inTest(['t'], () => expect({ id: 7 }).toMatchSnapshot({ id: 8 })), {
      message: 'properties t 1',
    })
    assert.equal(state.unmatched, 1)
    inTest(['t'], () => expect({ id: 7 }).toMatchSnapshot())
    state.finish()
    const text = readFileSync(snapPath, 'utf8')
    assert.match(text, /exports\[`t 2`\]/)
    assert.doesNotMatch(text, /exports\[`t 1`\]/)
  })

  test('properties must be an object, and the received value too', () => {
    const { expect, inTest } = setup()
    assert.throws(
      () => inTest(['t'], () => loose(expect(1)).toMatchSnapshot(1, 'hint')),
      /must be an object/,
    )
    assert.throws(
      () => inTest(['t'], () => loose(expect(1)).toMatchSnapshot({ a: 1 })),
      /received value must be an object/,
    )
  })

  test('is refused with .not', () => {
    const { expect, inTest } = setup()
    assert.throws(
      () => inTest(['t'], () => expect(1).not.toMatchSnapshot()),
      /cannot be used with not/,
    )
  })

  test('without a snapshot state it is an error with a code', () => {
    const { expect, inTest } = setup()
    expect.setState({ snapshotState: undefined })
    assert.throws(
      () => inTest(['t'], () => expect(1).toMatchSnapshot()),
      (error) => error instanceof SnapshotError && error.code === 'SNAPSHOT_NOT_INITIALIZED',
    )
  })
})

describe('expect.soft with the snapshot matchers (T7.8)', () => {
  const STORED = `${HEADER}\n\nexports[\`t 1\`] = \`1\`;\n\nexports[\`t 2\`] = \`2\`;\n`

  /** `expect.soft` of the setup: its presence is the point of the option. */
  const softOf = (expect: ExpectStatic): NonNullable<ExpectStatic['soft']> => {
    assert.ok(expect.soft, 'expect.soft is there under ExpectPolicy.soft')
    return expect.soft
  }

  test('a mismatch is held in suppressedErrors, with the result, and the test goes on', () => {
    const { expect, inRawTest, source, state } = setup({
      update: 'none',
      stored: STORED,
      soft: true,
    })
    inRawTest(['t'], () => {
      softOf(expect)(9).toMatchSnapshot()
      // The next line runs: the second snapshot of the test is checked and matches.
      expect(2).toMatchSnapshot()
      const held = source.current().suppressedErrors
      assert.equal(held.length, 1)
      assert.equal(held[0]?.message, 'mismatch t 1|t||1|9')
      assert.ok(held[0] instanceof MatcherResultError)
      assert.equal(held[0].matcherResult?.pass, false)
      assert.equal(source.current().numPassingAsserts, 1)
    })
    assert.equal(state.unmatched, 1)
    assert.equal(state.matched, 1)
  })

  test('the other snapshot matchers hold their failures the same way', () => {
    const { expect, inRawTest, source } = setup({ update: 'none', stored: STORED, soft: true })
    inRawTest(['t'], () => {
      softOf(expect)({ id: 7 }).toMatchSnapshot({ id: 8 })
      softOf(expect)(9).toMatchInlineSnapshot('1')
      softOf(expect)(() => {
        throw new Error('boom')
      }).toThrowErrorMatchingInlineSnapshot('different')
      assert.equal(source.current().suppressedErrors.length, 3)
    })
  })

  test('a hard assertion of another matcher beside a soft snapshot one still throws', () => {
    const { expect, inRawTest, source } = setup({ update: 'none', stored: STORED, soft: true })
    inRawTest(['t'], () => {
      softOf(expect)(9).toMatchSnapshot()
      assert.throws(() => expect(1).toBe(2), { message: 'toBe: 1 vs 2' })
      assert.equal(source.current().suppressedErrors.length, 1)
    })
  })

  test('a soft match that passes records nothing', () => {
    const { expect, inRawTest, source } = setup({ update: 'none', stored: STORED, soft: true })
    inRawTest(['t'], () => {
      softOf(expect)(1).toMatchSnapshot()
      assert.equal(source.current().suppressedErrors.length, 0)
      assert.equal(source.current().numPassingAsserts, 1)
    })
  })
})

describe('the snapshot matchers call dontThrow, as Jest`s do (T7.8)', () => {
  const STORED = `${HEADER}\n\nexports[\`t 1\`] = \`1\`;\n\nexports[\`t 2\`] = \`2\`;\n`

  test('a mismatch does not throw at the call: it is held, and the test fails when it ends', () => {
    const { expect, inRawTest, source } = setup({ update: 'none', stored: STORED })
    inRawTest(['t'], () => {
      expect(9).toMatchSnapshot()
      assert.equal(source.current().suppressedErrors.length, 1)
    })
  })

  test('the test`s other snapshots are still checked, and its end-of-test check throws the mismatch', () => {
    const { expect, inTest, state } = setup({ update: 'none', stored: STORED })
    assert.throws(
      () =>
        inTest(['t'], () => {
          expect(9).toMatchSnapshot()
          expect(2).toMatchSnapshot()
        }),
      { message: 'mismatch t 1|t||1|9' },
    )
    assert.equal(state.matched, 1)
  })

  test('a missing snapshot under `none` and a failed property match are held the same way', () => {
    const { expect, inRawTest, source } = setup({ update: 'none' })
    inRawTest(['t'], () => {
      expect(1).toMatchSnapshot()
      expect({ id: 7 }).toMatchSnapshot({ id: 8 })
      assert.deepEqual(
        source.current().suppressedErrors.map((error) => error.message),
        ['not written t 1|1', 'properties t 2'],
      )
    })
  })

  test('toThrowErrorMatchingSnapshot and the inline forms hold their mismatches', () => {
    const { expect, inRawTest, source } = setup({ update: 'none', stored: STORED })
    inRawTest(['t'], () => {
      expect(() => {
        throw new Error('boom')
      }).toThrowErrorMatchingSnapshot()
      expect(9).toMatchInlineSnapshot('1')
      assert.equal(source.current().suppressedErrors.length, 2)
    })
  })

  test('a matcher that throws on its own still throws at the call', () => {
    const { expect, inRawTest, source } = setup({ update: 'none', stored: STORED })
    inRawTest(['t'], () => {
      assert.throws(() => expect(1).not.toMatchSnapshot(), /cannot be used with not/)
      assert.equal(source.current().suppressedErrors.length, 0)
    })
  })

  test('toMatchFileSnapshot, which Jest does not have, still fails at the call', async () => {
    const { expect, dir, inRawTest, source } = setup({ update: 'none', fileSnapshot: true })
    put(join(dir, 'out', 'hello.txt'), 'hello\n')
    await inRawTest(['t'], async () => {
      await assert.rejects(
        async () => loose(expect('bye\n')).toMatchFileSnapshot('./out/hello.txt'),
        /mismatch/,
      )
      assert.equal(source.current().suppressedErrors.length, 0)
    })
  })
})

describe('toThrowErrorMatchingSnapshot', () => {
  const boom = (): never => {
    throw new Error('boom', { cause: new Error('inner cause') })
  }

  test('Jest`s body is the message and the cause chain', () => {
    const { expect, inTest, state, snapPath } = setup()
    inTest(['t'], () => expect(boom).toThrowErrorMatchingSnapshot())
    state.finish()
    assert.match(
      readFileSync(snapPath, 'utf8'),
      /exports\[`t 1`\] = `"boom\\\\nCause: inner cause"`;/,
    )
  })

  test('Vitest`s body is the error itself', () => {
    const { expect, inTest, state, snapPath } = setup({ throwErrorBody: 'error' })
    inTest(['t'], () => expect(boom).toThrowErrorMatchingSnapshot())
    state.finish()
    assert.match(readFileSync(snapPath, 'utf8'), /exports\[`t 1`\] = `\[Error: boom\]`;/)
  })

  test('works on a rejection, where the value is the error', async () => {
    const { expect, state, snapPath, inTest } = setup()
    await inTest(['t'], () =>
      expect(Promise.reject(new Error('later'))).rejects.toThrowErrorMatchingSnapshot(),
    )
    state.finish()
    assert.match(readFileSync(snapPath, 'utf8'), /exports\[`t 1`\] = `"later"`;/)
  })

  test('a thrown object without a message is stored as Jest stores it: the message as it is', () => {
    const { expect, inTest, state, snapPath } = setup()
    inTest(['t'], () =>
      expect(() => {
        throw { code: 1 }
      }).toThrowErrorMatchingSnapshot(),
    )
    state.finish()
    assert.match(readFileSync(snapPath, 'utf8'), /exports\[`t 1`\] = `undefined`;/)
  })

  test('a thrown string fails as it does in Jest (`cause` in a string)', () => {
    const { expect, inTest } = setup()
    assert.throws(
      () =>
        inTest(['t'], () =>
          expect(() => {
            throw 'boom'
          }).toThrowErrorMatchingSnapshot(),
        ),
      TypeError,
    )
  })

  test('a function that doesn`t throw, and a value that isn`t a function, are errors', () => {
    const { expect, inTest } = setup()
    assert.throws(
      () => inTest(['t'], () => expect(() => {}).toThrowErrorMatchingSnapshot()),
      /did not throw/,
    )
    assert.throws(
      () => inTest(['t'], () => expect(1).toThrowErrorMatchingSnapshot()),
      /must be a function/,
    )
  })
})

/** The line after the caller's (this file's own stack is not source-mapped: Node strips types in place). */
function nextLine(): number {
  const frame = new Error().stack?.split('\n')[2] ?? ''
  return Number(/:(\d+):\d+\)?$/.exec(frame)?.[1]) + 1
}

describe('inline snapshots', () => {
  test('compare in place: a match passes and a mismatch fails', () => {
    const { expect, inTest } = setup({ update: 'none' })
    inTest(['t'], () => expect(1).toMatchInlineSnapshot('1'))
    assert.throws(() => inTest(['t'], () => expect(2).toMatchInlineSnapshot('1')), /mismatch/)
  })

  test('the indentation a snapshot was written with is taken off', () => {
    const { expect, inTest } = setup({ update: 'none' })
    const indented = '\n        {\n          "a": 1\n        }\n      '
    inTest(['t'], () => expect({ a: 1 }).toMatchInlineSnapshot(indented))
  })

  test('a missing one fails naming T7.11 when it would be written, and nothing is written', () => {
    const { expect, inTest, state, snapPath } = setup()
    assert.throws(() => inTest(['t'], () => expect(1).toMatchInlineSnapshot()), /T7\.11/)
    state.finish()
    assert.equal(existsSync(snapPath), false)
  })

  test('with a writer, a missing one passes and is recorded at the matcher call (B23d B1)', () => {
    const { expect, inTest, state } = setup({ inlineWrites: true })
    const fail = (): never => {
      throw new Error('no')
    }
    const line = nextLine()
    inTest(['t'], () => expect({ a: 1 }).toMatchInlineSnapshot())
    inTest(['u'], () => expect(fail).toThrowErrorMatchingInlineSnapshot())
    const report = state.finish()
    assert.equal(report.added, 2)
    const edits = report.inline ?? []
    assert.deepEqual(
      edits.map(({ file, line: at, snapshot }) => ({ file, at, snapshot })),
      [
        { file: import.meta.filename, at: line, snapshot: '\n{\n  "a": 1\n}\n' },
        { file: import.meta.filename, at: line + 1, snapshot: '"no"' },
      ],
    )
    // The column is the matcher name's, 0-based: where Jest's writer looks for the call.
    const source = readFileSync(import.meta.filename, 'utf8').split('\n')
    for (const edit of edits) {
      const text = source[edit.line - 1] ?? ''
      assert.match(text.slice(edit.column), /^toM|^toT/)
    }
  })

  test('with a writer, `.resolves` records the call of the matcher property', async () => {
    const { expect, inTest, state } = setup({ inlineWrites: true })
    const line = nextLine()
    await inTest(['t'], () => expect(Promise.resolve(1)).resolves.toMatchInlineSnapshot())
    const [edit] = state.finish().inline ?? []
    assert.equal(edit?.line, line)
    const text = readFileSync(import.meta.filename, 'utf8').split('\n')[line - 1] ?? ''
    assert.match(text.slice(edit?.column ?? 0), /^toMatchInlineSnapshot/)
  })

  test('a missing one under `none` fails as a snapshot that was not written, not as T7.11', () => {
    const { expect, inTest } = setup({ update: 'none' })
    assert.throws(
      () => inTest(['t'], () => expect(1).toMatchInlineSnapshot()),
      (error) =>
        error instanceof Error &&
        !/T7\.11/.test(error.message) &&
        /not written/.test(error.message),
    )
  })

  test('toThrowErrorMatchingInlineSnapshot compares the message', () => {
    const { expect, inTest } = setup({ update: 'none' })
    const fail = (): never => {
      throw new Error('no')
    }
    inTest(['t'], () => expect(fail).toThrowErrorMatchingInlineSnapshot('"no"'))
    assert.throws(
      () => inTest(['t'], () => expect(fail).toThrowErrorMatchingInlineSnapshot('"yes"')),
      /mismatch/,
    )
    assert.throws(
      () => inTest(['t'], () => loose(expect(fail)).toThrowErrorMatchingInlineSnapshot(5)),
      /must be a string/,
    )
  })
})

describe('toMatchFileSnapshot', () => {
  const matchFile = (expect: ExpectStatic, value: unknown, file: string): Promise<void> =>
    loose(expect(value)).toMatchFileSnapshot(file) as Promise<void>

  test('writes the file beside the test, then compares it exactly', async () => {
    const first = setup({ fileSnapshot: true })
    await first.inTest(['t'], () => matchFile(first.expect, 'hello\n', './out/hello.txt'))
    first.state.finish()
    assert.equal(readFileSync(join(first.dir, 'out', 'hello.txt'), 'utf8'), 'hello\n')

    const second = setup({ fileSnapshot: true, update: 'none' })
    put(join(second.dir, 'out', 'hello.txt'), 'hello\n')
    await second.inTest(['t'], () => matchFile(second.expect, 'hello\n', './out/hello.txt'))
    await assert.rejects(
      second.inTest(['t'], () => matchFile(second.expect, 'bye\n', './out/hello.txt')),
      /mismatch/,
    )
  })

  test('is not registered unless the dialect asks for it', () => {
    const { expect } = setup()
    assert.equal(loose(expect(1)).toMatchFileSnapshot, undefined)
  })
})

describe('expect.addSnapshotSerializer', () => {
  test('puts a serializer in front, for the file`s snapshots', () => {
    const { expect, inTest, state, snapPath } = setup()
    expect.addSnapshotSerializer({ test: (v) => v === 'secret', serialize: () => 'HIDDEN' })
    inTest(['t'], () => expect('secret').toMatchSnapshot())
    state.finish()
    assert.match(readFileSync(snapPath, 'utf8'), /exports\[`t 1`\] = `HIDDEN`;/)
  })

  test('outside a file it is an error with a code', () => {
    const { expect } = setup()
    expect.setState({ snapshotState: undefined })
    assert.throws(
      () => expect.addSnapshotSerializer({ test: () => true, serialize: () => '' }),
      (error) => error instanceof SnapshotError && error.code === 'SNAPSHOT_NOT_INITIALIZED',
    )
  })
})
