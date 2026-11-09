import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { iterableEquality, subsetEquality } from '@jest/expect-utils'
import { SnapshotError, SnapshotState } from '@provino/snapshot/runtime'
import type { ExpectStatic, SnapshotMessageInfo, SnapshotPrinter } from '@provino/types'
import { createExpect } from './expect.ts'
import { manualCurrentTest, testPolicy, testTable, testTask } from './internal/test-support.ts'
import { createMatcherRegistry } from './slot.ts'
import { snapshotMatchers } from './snapshot-matchers.ts'
import { createStateSource } from './state.ts'

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
  throwErrorBody?: 'message' | 'error'
  keyJoin?: string
  hintJoin?: string
}

interface Setup {
  readonly expect: ExpectStatic
  readonly dir: string
  readonly state: SnapshotState
  readonly snapPath: string
  /** Runs `fn` as the test with this title path. */
  inTest<T>(titlePath: string[], fn: () => T, id?: string): T
}

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
    policy: testPolicy,
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
  })
  expect.setState({ snapshotState: state })
  return {
    expect,
    dir,
    state,
    snapPath,
    inTest(titlePath, fn, id = titlePath.join('/')) {
      current.enter(testTask(id, titlePath))
      try {
        return fn()
      } finally {
        current.enter(null)
      }
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
