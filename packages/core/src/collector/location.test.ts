// Lazy locations: a callsite is captured at registration and parsed only when the tree is built.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { locateMarker } from '../internal/test-support.ts'
import { CALLER_FRAMES, captureSite, parseSite, type Site, TEST_FILE_FRAMES } from './location.ts'

describe('captureSite', () => {
  test('is null when locations are off', () => {
    assert.equal(captureSite(captureSite, false), null)
  })

  test('captures the caller of the entry function, not the entry itself', () => {
    const register = (): Site | null => captureSite(register, true)
    // @marker:caller
    const site = register()
    assert.deepEqual(
      parseSite(site),
      locateMarker(import.meta.filename, '// @marker:caller', 'register()'),
    )
  })

  test('leaves Error.stackTraceLimit as it found it', () => {
    const before = Error.stackTraceLimit
    captureSite(captureSite, true)
    assert.equal(Error.stackTraceLimit, before)
  })

  /** The number of frames a site kept, captured from below `depth` nested calls. */
  const framesKept = (frames: number, depth: number): number => {
    const nest = (left: number): Site | null =>
      left === 0 ? captureSite(captureSite, true, frames) : nest(left - 1)
    const stack = nest(depth)?.stack ?? ''
    return stack.split('\n').filter((line) => line.trim().startsWith('at ')).length
  }

  test('keeps only a few frames by default, so reading it is cheap', () => {
    const site = captureSite(captureSite, true)
    const frames = (site?.stack ?? '').split('\n').filter((line) => line.trim().startsWith('at '))
    assert.ok(frames.length <= CALLER_FRAMES, `${frames.length} frames kept`)
  })

  test('keeps the frames it is asked for, so the test file can be found below a helper', () => {
    assert.equal(framesKept(TEST_FILE_FRAMES, 20), TEST_FILE_FRAMES)
    assert.equal(framesKept(CALLER_FRAMES, 20), CALLER_FRAMES)
  })
})

describe('parseSite', () => {
  const stack = (...frames: string[]): Site => ({ stack: ['Error', ...frames].join('\n') })

  test('is null for no site, or a site with no stack', () => {
    assert.equal(parseSite(null), null)
    assert.equal(parseSite({}), null)
  })

  test('reads the first frame, with its file, line and column', () => {
    const site = stack(
      '    at register (/project/a.test.ts:10:5)',
      '    at other (/project/b.ts:1:1)',
    )
    assert.deepEqual(parseSite(site), { file: '/project/a.test.ts', line: 10, column: 5 })
  })

  test('reads a frame with no function name', () => {
    assert.deepEqual(parseSite(stack('    at /project/a.test.ts:3:7')), {
      file: '/project/a.test.ts',
      line: 3,
      column: 7,
    })
  })

  test('reads an async frame', () => {
    assert.deepEqual(parseSite(stack('    at async run (/project/a.test.ts:4:2)')), {
      file: '/project/a.test.ts',
      line: 4,
      column: 2,
    })
  })

  test('turns a file: URL into a path, decoding it', () => {
    const site = stack('    at f (file:///project/my%20dir/a.test.ts:2:9)')
    assert.deepEqual(parseSite(site), { file: '/project/my dir/a.test.ts', line: 2, column: 9 })
  })

  test('skips a frame that has no position', () => {
    const site = stack('    at new Promise (<anonymous>)', '    at f (/project/a.test.ts:6:1)')
    assert.deepEqual(parseSite(site), { file: '/project/a.test.ts', line: 6, column: 1 })
  })

  test('is null when no frame has a position', () => {
    assert.equal(parseSite(stack('    at new Promise (<anonymous>)')), null)
    assert.equal(parseSite({ stack: 'Error' }), null)
  })

  describe('with the test file', () => {
    const testFile = '/project/a.test.ts'

    test('reads the first frame in the test file, past a helper in another file', () => {
      const site = stack(
        '    at helper (/project/helpers.ts:3:5)',
        '    at Object.<anonymous> (/project/a.test.ts:10:1)',
      )
      assert.deepEqual(parseSite(site, testFile), { file: testFile, line: 10, column: 1 })
    })

    test('matches a file: URL whose query a loader added', () => {
      const site = stack(
        '    at helper (file:///project/helpers.ts?core-run=3:3:5)',
        '    at file:///project/a.test.ts?core-run=3:10:1',
      )
      assert.deepEqual(parseSite(site, testFile), { file: testFile, line: 10, column: 1 })
    })

    test('falls back to the first frame when no frame is in the test file', () => {
      const site = stack(
        '    at helper (/project/helpers.ts:3:5)',
        '    at other (/project/other.ts:1:1)',
      )
      assert.deepEqual(parseSite(site, testFile), {
        file: '/project/helpers.ts',
        line: 3,
        column: 5,
      })
    })
  })

  test('keeps a path that is not a file: URL as it is', () => {
    assert.equal(
      parseSite(stack('    at f (node:internal/timers:5:1)'))?.file,
      'node:internal/timers',
    )
  })
})
