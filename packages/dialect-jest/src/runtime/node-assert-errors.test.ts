// `shapeTestError` (jest-circus 30.5.2's `formatNodeAssertErrors`, vendored) against the text Jest
// recorded for the same failures: `cli/node-assert`'s results file holds one `failureMessages[0]`
// per test, whose stack frames the recorder replaces with `<frames>`. Each case here throws what
// the fixture's test throws; its text up to the first frame must be the recorded one.
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { stripVTControlCharacters } from 'node:util'
import { shapeTestError } from './node-assert-errors.ts'

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
    const shaped = shapeTestError(thrownBy(run), EXPAND) as { message: string }
    const want = beforeFrames(result.failureMessages[0] ?? '')
    // The recorder takes one newline into the run of frames, so only trailing space is compared loosely.
    assert.equal(
      stripColour(beforeFrames(shaped.message)).trimEnd(),
      want.trimEnd(),
      result.fullName,
    )
    // `failureDetails[0]` is `{ message }` as well (`--json` writes it); name and code ride hidden.
    assert.deepEqual(Object.keys(shaped), ['message'])
  }
  assert.deepEqual([...unmatched], [], 'every case matched a recorded test')
  assert.deepEqual(skipped, Object.keys(SKIPPED))
})

test('the shaped value keeps the assertion error name and code, hidden', () => {
  const shaped = shapeTestError(thrownBy(THROWN.equal as () => unknown), EXPAND) as {
    name?: string
    code?: string
  }
  assert.equal(shaped.name, 'AssertionError')
  assert.equal(shaped.code, 'ERR_ASSERTION')
  assert.deepEqual(Object.keys(shaped), ['message'])
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

test('the text starts with the hint, whatever colour chalk has', () => {
  const shaped = shapeTestError(thrownBy(THROWN.equal as () => unknown), EXPAND) as {
    message: string
  }
  assert.ok(stripColour(shaped.message).startsWith('assert.equal(received, expected)'))
})
