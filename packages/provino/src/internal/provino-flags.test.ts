import assert from 'node:assert/strict'
import { describe, it } from 'provino'
import { takeProvinoFlags } from './provino-flags.ts'
import { UsageError } from './usage-error.ts'

describe('takeProvinoFlags (provino jest)', () => {
  it('takes --no-emoji before and after the positionals, and leaves Jest the rest in order', () => {
    assert.deepEqual(takeProvinoFlags(['--no-emoji', 'a.test', '-t', 'x']), {
      rest: ['a.test', '-t', 'x'],
      timingsFile: undefined,
      updateTimings: false,
      noEmoji: true,
      views: {},
    })
    assert.deepEqual(takeProvinoFlags(['a.test', '--ci', '--no-emoji']).rest, ['a.test', '--ci'])
    assert.equal(takeProvinoFlags(['a.test', '--ci', '--no-emoji']).noEmoji, true)
    assert.equal(takeProvinoFlags(['a.test']).noEmoji, false)
  })

  it('takes --tree and --map, in any place before --, as the provino reporter’s views', () => {
    assert.deepEqual(takeProvinoFlags(['--tree', 'a.test']).views, { tree: true })
    assert.deepEqual(takeProvinoFlags(['a.test', '--map']).views, { map: true })
    assert.deepEqual(takeProvinoFlags(['--map', '-t', 'x', '--tree', '--ci']).views, {
      tree: true,
      map: true,
    })
    assert.deepEqual(takeProvinoFlags(['--map', '-t', 'x', '--tree', '--ci']).rest, [
      '-t',
      'x',
      '--ci',
    ])
    assert.deepEqual(takeProvinoFlags(['a.test']).views, {})
    // The flag is the exact word: Jest's own refusal of anything else is left to Jest.
    assert.deepEqual(takeProvinoFlags(['--treeish', '--maps', '--tree=true']).rest, [
      '--treeish',
      '--maps',
      '--tree=true',
    ])
  })

  it('leaves everything after -- to Jest: a pattern named like the flag is a pattern', () => {
    const taken = takeProvinoFlags(['--update-timings', '--', '--no-emoji', '--timings', '--tree'])
    assert.deepEqual(taken.rest, ['--', '--no-emoji', '--timings', '--tree'])
    assert.equal(taken.noEmoji, false)
    assert.deepEqual(taken.views, {})
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
