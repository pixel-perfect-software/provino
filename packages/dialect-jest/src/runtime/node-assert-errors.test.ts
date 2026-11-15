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

/** What each test of the fixture throws, by title. */
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
  strictEqual_in_describe: () => assert.strictEqual(received.c, expected.c),
  'never runs': () => assert.notStrictEqual(1, 1),
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

test('every recorded node:assert failure but the async one is what Jest printed', () => {
  assert.ok(recorded !== undefined && recorded.length > 0, 'the golden has results')
  let compared = 0
  for (const result of recorded) {
    const title =
      result.title === 'strictEqual' && compared > 12 ? 'strictEqual_in_describe' : result.title
    const run = THROWN[title]
    if (run === undefined) continue // `rejects`: awaited, covered end to end
    const shaped = shapeTestError(thrownBy(run)) as { message: string }
    const want = beforeFrames(result.failureMessages[0] ?? '')
    // The recorder takes one newline into the run of frames, so only trailing space is compared loosely.
    assert.equal(stripColour(beforeFrames(shaped.message)).trimEnd(), want.trimEnd(), result.title)
    // `failureDetails[0]` is `{ message }` as well (`--json` writes it).
    assert.deepEqual(Object.keys(shaped), ['message'])
    compared++
  }
  assert.equal(compared, 17)
})

test('an error that is no assertion error is returned as it is', () => {
  const error = new Error('plain')
  assert.equal(shapeTestError(error), error)
  assert.equal(shapeTestError('text'), 'text')
  assert.equal(shapeTestError(undefined), undefined)
  assert.equal(shapeTestError(null), null)
})

test('the text starts with the hint, whatever colour chalk has', () => {
  const shaped = shapeTestError(thrownBy(THROWN.equal as () => unknown)) as { message: string }
  assert.ok(stripColour(shaped.message).startsWith('assert.equal(received, expected)'))
})
