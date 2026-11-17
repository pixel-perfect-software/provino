import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { takeProvinoFlags } from './provino-flags.ts'
import { UsageError } from './usage-error.ts'

describe('takeProvinoFlags (provino jest)', () => {
  it('takes --no-emoji before and after the positionals, and leaves Jest the rest in order', () => {
    assert.deepEqual(takeProvinoFlags(['--no-emoji', 'a.test', '-t', 'x']), {
      rest: ['a.test', '-t', 'x'],
      timingsFile: undefined,
      updateTimings: false,
      noEmoji: true,
    })
    assert.deepEqual(takeProvinoFlags(['a.test', '--ci', '--no-emoji']).rest, ['a.test', '--ci'])
    assert.equal(takeProvinoFlags(['a.test', '--ci', '--no-emoji']).noEmoji, true)
    assert.equal(takeProvinoFlags(['a.test']).noEmoji, false)
  })

  it('leaves everything after -- to Jest: a pattern named like the flag is a pattern', () => {
    const taken = takeProvinoFlags(['--update-timings', '--', '--no-emoji', '--timings'])
    assert.deepEqual(taken.rest, ['--', '--no-emoji', '--timings'])
    assert.equal(taken.noEmoji, false)
    assert.equal(taken.updateTimings, true)
  })

  it('takes --timings in both forms, and refuses one with no path', () => {
    assert.equal(takeProvinoFlags(['--timings', 't.json', '--no-emoji']).timingsFile, 't.json')
    assert.equal(takeProvinoFlags(['--timings=-x']).timingsFile, '-x')
    for (const args of [['--timings'], ['--timings', '--no-emoji'], ['--timings=']]) {
      assert.throws(
        () => takeProvinoFlags(args),
        (error) => error instanceof UsageError && /--timings needs the path/.test(error.message),
      )
    }
  })
})
