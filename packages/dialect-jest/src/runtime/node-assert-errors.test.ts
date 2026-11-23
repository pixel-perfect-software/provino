// `shapeTestError` (jest-circus 30.5.2's `formatNodeAssertErrors`, vendored) against the text Jest
// recorded for the same failures: `cli/node-assert`'s results file holds one `failureMessages[0]`
// per test, whose stack frames the recorder replaces with `<frames>`. Each case here throws what
// the fixture's test throws; its text up to the first frame must be the recorded one.
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { describe, test } from 'provino'
import { shapeTestError } from './node-assert-errors.ts'
import formatNodeAssertErrors from './vendor/jest-circus/formatNodeAssertErrors.ts'

interface Recorded {
  readonly testResults: readonly {
    readonly assertionResults: readonly {
      readonly title: string
      readonly fullName: string
      readonly failureMessages: readonly string[]
      readonly failureDetails: readonly unknown[]
    }[]
  }[]
}

const GOLDEN = new URL(
  '../../../harness/fixtures/cli/node-assert/__goldens__/jest.json',
  import.meta.url,
)
const recorded = (
  JSON.parse(readFileSync(GOLDEN, 'utf8')) as {
    observed: { json: Record<string, Recorded> }
  }
).observed.json['.harness-out/jest.json']?.testResults[0]?.assertionResults

const received = { a: 1, b: [1, 2, 3], c: 'x' }
const expected = { a: 1, b: [1, 2, 4], c: 'y' }

const EXPAND = { expand: false } as const

/** What each test of the fixture throws, by full name (ancestor titles and title, as Jest joins them). */
const THROWN: Record<string, () => unknown> = {
  equal: () => assert.equal(1, 2),
  notEqual: () => assert.notEqual(1, 1),
  strictEqual: () => assert.strictEqual('a', 'b'),
  'deepStrictEqual of objects': () => assert.deepStrictEqual(received, expected),
  deepEqual: () => assert.deepEqual([1, 2], [1, 3]),
  ok: () => assert.ok(false),
  'throws without a throw': () => assert.throws(() => {}),
  'throws with the wrong error': () =>
    assert.throws(() => {
      throw new Error('boom')
    }, /other/),
  doesNotThrow: () =>
    assert.doesNotThrow(() => {
      throw new Error('boom')
    }),
  match: () => assert.match('abc', /x/),
  'fail with a message': () => assert.fail('gave up'),
  'fail without a message': () => assert.fail(),
  'custom message': () => assert.strictEqual(1, 2, 'one is not two'),
  'an AssertionError built by hand': () => {
    throw new assert.AssertionError({
      message: 'by hand',
      actual: 1,
      expected: 2,
      operator: 'strictEqual',
    })
  },
  'an error that only carries the code': () => {
    throw Object.assign(new Error('looks like one'), {
      code: 'ERR_ASSERTION',
      actual: 1,
      expected: 2,
      operator: '==',
    })
  },
  'a thrown object with the code and no stack': () => {
    throw { code: 'ERR_ASSERTION', message: 'm', actual: 1, expected: 2, operator: '==' }
  },
  'inside a describe strictEqual': () => assert.strictEqual(received.c, expected.c),
  'inside a describe nested never runs': () => assert.notStrictEqual(1, 1),
}

function thrownBy(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('the case did not throw')
}

const stripColour = stripVTControlCharacters
const beforeFrames = (text: string): string =>
  (text.split(/\n\s+at(?: |\b)/)[0] ?? text).replace(/\n*<frames>$/, '')

/**
 * Cases Jest prints as ordinary errors: circus formats a thrown value only when it has a stack, so
 * the shaper hands these back as they were thrown.
 */
const AS_THROWN: ReadonlySet<string> = new Set(['a thrown object with the code and no stack'])

/** `rejects` is awaited, which a synchronous case can't do: it is held end to end by `cli/node-assert`. */
const SKIPPED: Record<string, string> = {
  rejects: 'awaited: covered end to end by provino/test/jest-node-assert.test.ts',
}

test('every recorded node:assert failure is what Jest printed', () => {
  assert.ok(recorded !== undefined && recorded.length > 0, 'the golden has results')
  const unmatched = new Set(Object.keys(THROWN))
  const skipped: string[] = []
  for (const result of recorded) {
    const reason = SKIPPED[result.fullName]
    if (reason !== undefined) {
      skipped.push(result.fullName)
      continue
    }
    const run = THROWN[result.fullName]
    assert.ok(run !== undefined, `no case for the recorded test "${result.fullName}"`)
    unmatched.delete(result.fullName)
    const thrown = thrownBy(run)
    if (AS_THROWN.has(result.fullName)) {
      assert.equal(shapeTestError(thrown, EXPAND), thrown, result.fullName)
      continue
    }
    const shaped = shapeTestError(thrown, EXPAND) as { message: string }
    const want = beforeFrames(result.failureMessages[0] ?? '')
    // The recorder takes one newline into the run of frames, so only trailing space is compared loosely.
    assert.equal(
      stripColour(beforeFrames(shaped.message)).trimEnd(),
      want.trimEnd(),
      result.fullName,
    )
    // `failureDetails[0]` is `{ message }` as well (`--json` writes it); the name rides hidden.
    assert.deepEqual(Object.keys(shaped), ['message'])
  }
  assert.deepEqual([...unmatched], [], 'every case matched a recorded test')
  assert.deepEqual(skipped, Object.keys(SKIPPED))
})

test('the shaped value keeps the assertion error name, hidden', () => {
  const shaped = shapeTestError(thrownBy(THROWN.equal as () => unknown), EXPAND) as {
    name?: string
  }
  assert.equal(shaped.name, 'AssertionError')
})

test('expand prints the whole diff, as state.expand does', () => {
  const error = thrownBy(() =>
    assert.deepStrictEqual(
      { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10, k: 11, l: 12, m: 13, n: 99 },
      { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10, k: 11, l: 12, m: 13, n: 14 },
    ),
  )
  const plain = (shapeTestError(error, { expand: false }) as { message: string }).message
  const expanded = (shapeTestError(error, { expand: true }) as { message: string }).message
  assert.notEqual(stripColour(plain), stripColour(expanded))
})

test('an error that is no assertion error is returned as it is', () => {
  const error = new Error('plain')
  assert.equal(shapeTestError(error, EXPAND), error)
  assert.equal(shapeTestError('text', EXPAND), 'text')
  assert.equal(shapeTestError(undefined, EXPAND), undefined)
  assert.equal(shapeTestError(null, EXPAND), null)
})

// The goldens above are compared with the colour stripped, so a colour level of `RESET` that is not
// the others' would pass them. With colour forced on, the text must start with the hint painted by
// `jest-matcher-utils`' own colour functions and the line after it painted by the `chalk.reset` of
// the Chalk they use, byte for byte.
test('the text starts with the hint at the colour level in use', () => {
  const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))
  const script = `
    import { createRequire } from 'node:module'
    import assert from 'node:assert'
    const { shapeTestError } = await import(${JSON.stringify(here('./node-assert-errors.ts'))})
    const require = createRequire(${JSON.stringify(here('../../package.json'))})
    const utils = require('jest-matcher-utils')
    const chalk = createRequire(require.resolve('jest-matcher-utils'))('chalk')
    let error
    try { assert.equal(1, 2) } catch (thrown) { error = thrown }
    const { message } = shapeTestError(error, { expand: false })
    const hint = utils.DIM_COLOR('assert') + utils.DIM_COLOR('.equal(') +
      utils.RECEIVED_COLOR('received') + utils.DIM_COLOR(', ') +
      utils.EXPECTED_COLOR('expected') + utils.DIM_COLOR(')')
    const expected = hint + '\\n\\n' + chalk.reset('Expected value to be equal to:\\n')
    console.log(JSON.stringify({ painted: expected.includes('\\u001b['), starts: message.startsWith(expected) }))
  `
  const { NO_COLOR: _noColor, ...inherited } = process.env
  const result = spawnSync(
    process.execPath,
    ['--conditions=provino-source', '--input-type=module', '-e', script],
    { encoding: 'utf8', env: { ...inherited, FORCE_COLOR: '1' } },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1) ?? 'null'), {
    painted: true,
    starts: true,
  })
})

// jest-circus maps each entry of `test.errors` at `test_done` (`formatNodeAssertErrors.ts` L46-L74):
// a pair `[error, asyncError]` is read by its error, with `asyncError` (circus's own, an ordinary
// Error) standing in for one that has no stack, and any other entry is the error itself. Only the
// pair's branch looks at the stack.
describe('formatNodeAssertErrors takes an entry as circus keeps it', () => {
  const assertionError = (): unknown => thrownBy(() => assert.strictEqual(1, 2))
  const lookalike = (extra: object = {}): Record<string, unknown> => ({
    code: 'ERR_ASSERTION',
    message: 'm',
    actual: 1,
    expected: 2,
    operator: '==',
    ...extra,
  })
  const messageOf = (shaped: unknown): string => (shaped as { message: string }).message

  test('a bare entry is read as the error: an empty stack is not set aside', () => {
    // Circus checks `.stack` only for a pair, so a bare entry is formatted.
    const bare = lookalike({ stack: '' })
    const shaped = formatNodeAssertErrors(bare, false)
    assert.notEqual(shaped, bare)
    assert.ok(stripColour(messageOf(shaped)).startsWith('assert.equal(received, expected)'))
    assert.deepEqual(Object.keys(shaped as object), ['message'])
  })

  test('a bare value with no stack at all is circus’s TypeError (`stack.replace`)', () => {
    assert.throws(() => formatNodeAssertErrors(lookalike(), false), TypeError)
  })

  test('a pair is read by its error when that has a stack', () => {
    const shaped = formatNodeAssertErrors([assertionError(), new Error()], false)
    assert.ok(stripColour(messageOf(shaped)).startsWith('assert.strictEqual(received, expected)'))
  })

  test('a pair whose error has no stack falls back to its asyncError, which takes the error’s message', () => {
    const asyncError = new Error('registered here')
    const pair = [lookalike(), asyncError]
    assert.equal(formatNodeAssertErrors(pair, false), pair)
    assert.equal(asyncError.message, 'm')
    const noMessage = new Error()
    const other = [{ code: 'ERR_ASSERTION', actual: 1 }, noMessage]
    assert.equal(formatNodeAssertErrors(other, false), other)
    assert.equal(
      noMessage.message,
      'thrown: Object {\n  "actual": 1,\n  "code": "ERR_ASSERTION",\n}',
    )
  })

  test('a pair with no error is read by its asyncError, and a pair with neither is left', () => {
    const shaped = formatNodeAssertErrors([undefined, assertionError()], false)
    assert.ok(stripColour(messageOf(shaped)).startsWith('assert.strictEqual(received, expected)'))
    const lone = [lookalike(), undefined]
    assert.equal(formatNodeAssertErrors(lone, false), lone)
    const nothing = [null, undefined]
    assert.equal(formatNodeAssertErrors(nothing, false), nothing)
  })

  test('an entry that is no assertion error is the entry itself, in either shape', () => {
    const pair = [new Error('plain'), new Error()]
    assert.equal(formatNodeAssertErrors(pair, false), pair)
    const error = new Error('plain')
    assert.equal(formatNodeAssertErrors(error, false), error)
    assert.equal(formatNodeAssertErrors('text', false), 'text')
  })
})
