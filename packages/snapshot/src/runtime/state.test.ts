import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { SnapshotError } from '@provino/snapshot'
import { HEADER, policy, put, snapText, stateIn, tempDir } from './test-support.ts'

const snapPath = (dir: string): string => join(dir, '__snapshots__', 'a.test.ts.snap')

describe('match: writing and comparing', () => {
  test('a new snapshot is written at save, in `new` mode', () => {
    const dir = tempDir()
    const state = stateIn(dir)
    const result = state.match({ testName: 'a b', received: { x: 1 }, isInline: false })
    assert.equal(result.pass, true)
    assert.equal(result.key, 'a b 1')
    assert.equal(state.added, 1)
    const report = state.finish()
    assert.equal(report.added, 1)
    assert.equal(
      readFileSync(snapPath(dir), 'utf8'),
      `${HEADER}\n\nexports[\`a b 1\`] = \`\n{\n  "x": 1\n}\n\`;\n`,
    )
  })

  test('the count per test name keeps going, so two snapshots in a test get 1 and 2', () => {
    const state = stateIn(tempDir())
    assert.equal(state.match({ testName: 't', received: 1, isInline: false }).key, 't 1')
    assert.equal(state.match({ testName: 't', received: 2, isInline: false }).key, 't 2')
    assert.equal(state.match({ testName: 'u', received: 1, isInline: false }).key, 'u 1')
  })

  test('a stored snapshot that matches counts as matched and is not rewritten', () => {
    const dir = tempDir()
    const text = snapText({ 't 1': '1' })
    put(dir, '__snapshots__/a.test.ts.snap', text)
    const state = stateIn(dir)
    const result = state.match({ testName: 't', received: 1, isInline: false })
    assert.equal(result.pass, true)
    assert.equal(state.matched, 1)
    const report = state.finish()
    assert.equal(report.matched, 1)
    assert.equal(report.unchecked, 0)
    assert.equal(readFileSync(snapPath(dir), 'utf8'), text, 'an unchanged file is not rewritten')
  })

  test('a stored snapshot that differs fails with actual and expected', () => {
    const dir = tempDir()
    put(dir, '__snapshots__/a.test.ts.snap', snapText({ 't 1': '1' }))
    const state = stateIn(dir)
    const result = state.match({ testName: 't', received: 2, isInline: false })
    assert.equal(result.pass, false)
    assert.equal(result.actual, '2')
    assert.equal(result.expected, '1')
    assert.equal(state.unmatched, 1)
    state.finish()
    assert.equal(readFileSync(snapPath(dir), 'utf8'), snapText({ 't 1': '1' }), 'kept as it was')
  })

  test('`none` writes nothing and fails a missing snapshot, with expected undefined', () => {
    const dir = tempDir()
    const state = stateIn(dir, { update: 'none' })
    const result = state.match({ testName: 't', received: 1, isInline: false })
    assert.equal(result.pass, false)
    assert.equal(result.expected, undefined)
    assert.equal(state.unmatched, 1)
    state.finish()
    assert.equal(existsSync(snapPath(dir)), false)
  })

  test('`all` rewrites a snapshot that differs and counts it updated', () => {
    const dir = tempDir()
    put(dir, '__snapshots__/a.test.ts.snap', snapText({ 't 1': '1' }))
    const state = stateIn(dir, { update: 'all' })
    assert.equal(state.match({ testName: 't', received: 2, isInline: false }).pass, true)
    assert.equal(state.updated, 1)
    state.finish()
    assert.match(readFileSync(snapPath(dir), 'utf8'), /exports\[`t 1`\] = `2`;/)
  })

  test('`all` counts a matching snapshot as matched, not updated', () => {
    const dir = tempDir()
    put(dir, '__snapshots__/a.test.ts.snap', snapText({ 't 1': '1' }))
    const state = stateIn(dir, { update: 'all' })
    state.match({ testName: 't', received: 1, isInline: false })
    assert.equal(state.matched, 1)
    assert.equal(state.updated, 0)
  })

  test('a snapshot missing from an existing file is added in `new` mode, and fails in `none`', () => {
    const dir = tempDir()
    put(dir, '__snapshots__/a.test.ts.snap', snapText({ 't 1': '1' }))
    const adding = stateIn(dir)
    adding.match({ testName: 't', received: 1, isInline: false })
    assert.equal(adding.match({ testName: 't', received: 2, isInline: false }).pass, true)
    assert.equal(adding.added, 1)
    const failing = stateIn(dir, { update: 'none' })
    failing.match({ testName: 't', received: 1, isInline: false })
    assert.equal(failing.match({ testName: 't', received: 2, isInline: false }).pass, false)
  })

  test('a multi-line snapshot is stored with a line break at each end and compared without them', () => {
    const dir = tempDir()
    const state = stateIn(dir)
    state.match({ testName: 't', received: [1], isInline: false })
    state.finish()
    assert.match(readFileSync(snapPath(dir), 'utf8'), /= `\n\[\n {2}1\n\]\n`;/)
    const again = stateIn(dir, { update: 'none' })
    assert.equal(again.match({ testName: 't', received: [1], isInline: false }).pass, true)
    const wrong = stateIn(dir, { update: 'none' })
    const mismatch = wrong.match({ testName: 't', received: [2], isInline: false })
    assert.equal(mismatch.actual, '[\n  2\n]')
    assert.equal(mismatch.expected, '[\n  1\n]')
  })

  test('the file is saved sorted in natural order', () => {
    const dir = tempDir()
    const state = stateIn(dir)
    for (const name of ['numbers 10', 'numbers 2', 'a']) {
      state.match({ testName: name, received: 1, isInline: false })
    }
    state.finish()
    const keys = [...readFileSync(snapPath(dir), 'utf8').matchAll(/exports\[`([^`]+)`\]/g)].map(
      (m) => m[1],
    )
    assert.deepEqual(keys, ['a 1', 'numbers 2 1', 'numbers 10 1'])
  })

  test('a save leaves no temp file behind', () => {
    const dir = tempDir()
    const state = stateIn(dir)
    state.match({ testName: 't', received: 1, isInline: false })
    state.finish()
    assert.deepEqual(readdirSync(join(dir, '__snapshots__')), ['a.test.ts.snap'])
  })

  test('the printer gets the format with maxOutputLength left out when null, and the extra options', () => {
    const seen: unknown[] = []
    const state = stateIn(tempDir(), {
      printer: {
        serialize: (_value, options) => {
          seen.push({ ...options.format })
          return 'x'
        },
        messages: stateIn(tempDir()).messages,
      },
      policy: {
        ...policy,
        format: {
          escapeString: true,
          printBasicPrototype: false,
          maxOutputLength: 9,
          extra: { indent: 4 },
        },
      },
    })
    state.match({ testName: 't', received: 1, isInline: false })
    assert.equal(
      JSON.stringify(seen),
      JSON.stringify([
        { escapeString: true, printBasicPrototype: false, maxOutputLength: 9, indent: 4 },
      ]),
    )
    const plain = stateIn(tempDir(), {
      printer: {
        serialize: (_value, options) => {
          seen.push({ ...options.format })
          return 'x'
        },
        messages: stateIn(tempDir()).messages,
      },
    })
    plain.match({ testName: 't', received: 1, isInline: false })
    assert.equal(
      JSON.stringify(seen[1]),
      JSON.stringify({ escapeString: false, printBasicPrototype: false }),
    )
  })

  test('serializers added later are tried first', () => {
    const state = stateIn(tempDir())
    state.addSerializer({ test: (v) => v === 1, serialize: () => 'first' })
    state.addSerializer({ test: (v) => v === 1, serialize: () => 'second' })
    assert.equal(state.match({ testName: 't', received: 1, isInline: false }).key, 't 1')
    state.finish()
    assert.deepEqual(state.serializers.length, 2)
  })

  test('a serializer that is not a plugin is refused with a code', () => {
    const state = stateIn(tempDir())
    assert.throws(
      () => state.addSerializer({ test: () => true } as never),
      (error) => error instanceof SnapshotError && error.code === 'SNAPSHOT_BAD_SERIALIZER',
    )
  })
})

describe('obsolete snapshots', () => {
  const stored = snapText({ 'kept 1': '1', 'obsolete 1': '2' })

  test('a stored snapshot nothing checked is reported unchecked, and the file is kept as it was', () => {
    const dir = tempDir()
    put(dir, '__snapshots__/a.test.ts.snap', stored)
    const state = stateIn(dir)
    state.match({ testName: 'kept', received: 1, isInline: false })
    const report = state.finish()
    assert.equal(report.unchecked, 1)
    assert.deepEqual(report.uncheckedKeys, ['obsolete 1'])
    assert.equal(readFileSync(snapPath(dir), 'utf8').includes('obsolete 1'), true)
  })

  test('`all` removes the obsolete snapshots and the report still counts them', () => {
    const dir = tempDir()
    put(dir, '__snapshots__/a.test.ts.snap', stored)
    const state = stateIn(dir, { update: 'all' })
    state.match({ testName: 'kept', received: 1, isInline: false })
    const report = state.finish()
    assert.equal(report.unchecked, 1)
    assert.equal(readFileSync(snapPath(dir), 'utf8').includes('obsolete 1'), false)
  })

  test('`all` deletes the file when no snapshot is left, and the report says so', () => {
    const dir = tempDir()
    put(dir, '__snapshots__/a.test.ts.snap', stored)
    const state = stateIn(dir, { update: 'all' })
    const report = state.finish()
    assert.equal(report.fileDeleted, true)
    assert.equal(report.unchecked, 0, 'a deleted file has nothing obsolete left')
    assert.equal(report.file, null)
    assert.equal(existsSync(snapPath(dir)), false)
  })

  test('without `all` an empty file is only reported deleted, and kept', () => {
    const dir = tempDir()
    put(dir, '__snapshots__/a.test.ts.snap', `${HEADER}\n\n`)
    const report = stateIn(dir).finish()
    assert.equal(report.fileDeleted, true, 'Jest counts it as a removed file')
    assert.equal(existsSync(snapPath(dir)), true)
  })

  test('markCheckedForTest clears a test and its hinted keys, not another test with a longer name', () => {
    const dir = tempDir()
    put(
      dir,
      '__snapshots__/a.test.ts.snap',
      snapText({ 'a b 1': '1', 'a b: hint 1': '2', 'a bc 1': '3', 'x 1': '4' }),
    )
    const state = stateIn(dir)
    state.markCheckedForTest('a b')
    assert.deepEqual(state.getUncheckedKeys().sort(), ['a bc 1', 'x 1'])
  })
})

describe('retries', () => {
  test('clearTest takes back a test attempt: its snapshot, counters, checked keys and totals', () => {
    const dir = tempDir()
    put(dir, '__snapshots__/a.test.ts.snap', snapText({ 't 1': '1' }))
    const state = stateIn(dir)
    state.match({ testName: 't', testId: 'id', received: 1, isInline: false })
    state.match({ testName: 't', testId: 'id', received: 2, isInline: false })
    assert.equal(state.added, 1)
    assert.equal(state.matched, 1)
    state.clearTest('id')
    assert.equal(state.added, 0)
    assert.equal(state.matched, 0)
    assert.deepEqual(state.getUncheckedKeys(), ['t 1'])
    const again = state.match({ testName: 't', testId: 'id', received: 1, isInline: false })
    assert.equal(again.key, 't 1', 'the counter went back to 0')
    const second = state.match({ testName: 't', testId: 'id', received: 2, isInline: false })
    assert.equal(second.key, 't 2')
    assert.equal(state.added, 1, 'the second snapshot is written again, not reported as matched')
  })

  test('clearTest leaves another test alone', () => {
    const state = stateIn(tempDir())
    state.match({ testName: 'a', testId: 'A', received: 1, isInline: false })
    state.match({ testName: 'b', testId: 'B', received: 1, isInline: false })
    state.clearTest('A')
    assert.equal(state.added, 1)
    const report = state.finish()
    assert.equal(report.added, 1)
  })

  test('a retry that wrote nothing else does not leave the file dirty', () => {
    const dir = tempDir()
    const state = stateIn(dir)
    state.match({ testName: 't', testId: 'id', received: 1, isInline: false })
    state.clearTest('id')
    state.finish()
    assert.equal(existsSync(snapPath(dir)), false, 'nothing was left to save')
  })
})

describe('header', () => {
  test('a file with another header is rewritten in `new` mode', () => {
    const dir = tempDir()
    put(dir, '__snapshots__/a.test.ts.snap', snapText({ 't 1': '1' }, '// Other Snapshot v1'))
    const state = stateIn(dir)
    state.match({ testName: 't', received: 1, isInline: false })
    state.finish()
    assert.equal(readFileSync(snapPath(dir), 'utf8').startsWith(HEADER), true)
  })

  test('under `none` it is an error with a code, since nothing may be written', () => {
    const dir = tempDir()
    put(dir, '__snapshots__/a.test.ts.snap', snapText({ 't 1': '1' }, '// Other Snapshot v1'))
    assert.throws(
      () => stateIn(dir, { update: 'none' }),
      (error) => error instanceof SnapshotError && error.code === 'SNAPSHOT_HEADER_MISMATCH',
    )
  })

  test('a file with no header at all is an error under `none`', () => {
    const dir = tempDir()
    put(dir, '__snapshots__/a.test.ts.snap', 'exports[`t 1`] = `1`;\n')
    assert.throws(() => stateIn(dir, { update: 'none' }), /no snapshot header/)
  })
})

describe('inline snapshots', () => {
  test('a stored inline snapshot that matches passes, and one that differs fails', () => {
    const state = stateIn(tempDir(), { update: 'none' })
    assert.equal(
      state.match({ testName: 't', received: 1, isInline: true, inlineSnapshot: '1' }).pass,
      true,
    )
    const result = state.match({ testName: 't', received: 2, isInline: true, inlineSnapshot: '1' })
    assert.equal(result.pass, false)
    assert.equal(result.inlineNotWritten, false)
    assert.equal(result.expected, '1')
  })

  test('a missing inline snapshot would be written into the source: it fails, flagged, and writes nothing', () => {
    const dir = tempDir()
    const state = stateIn(dir)
    const result = state.match({ testName: 't', received: 1, isInline: true })
    assert.equal(result.pass, false)
    assert.equal(result.inlineNotWritten, true)
    assert.equal(state.added, 0)
    assert.equal(state.unmatched, 1)
    state.finish()
    assert.equal(existsSync(snapPath(dir)), false)
  })

  test('under `none` a missing inline snapshot is a plain failure, as Jest has it', () => {
    const result = stateIn(tempDir(), { update: 'none' }).match({
      testName: 't',
      received: 1,
      isInline: true,
    })
    assert.equal(result.pass, false)
    assert.equal(result.inlineNotWritten, false)
    assert.equal(result.expected, undefined)
  })

  test('`all` over a differing inline snapshot also needs the writer', () => {
    const result = stateIn(tempDir(), { update: 'all' }).match({
      testName: 't',
      received: 2,
      isInline: true,
      inlineSnapshot: '1',
    })
    assert.equal(result.inlineNotWritten, true)
  })

  test('`all` over a matching inline snapshot is a match', () => {
    const state = stateIn(tempDir(), { update: 'all' })
    const result = state.match({ testName: 't', received: 1, isInline: true, inlineSnapshot: '1' })
    assert.equal(result.pass, true)
    assert.equal(state.matched, 1)
  })

  test('an inline snapshot does not check a stored key of the same name', () => {
    const dir = tempDir()
    put(dir, '__snapshots__/a.test.ts.snap', snapText({ 't 1': '1' }))
    const state = stateIn(dir, { update: 'none' })
    state.match({ testName: 't', received: 1, isInline: true, inlineSnapshot: '1' })
    assert.deepEqual(state.getUncheckedKeys(), ['t 1'])
  })
})

describe('test.failing', () => {
  test('a mismatch is reported without counting, and the stored snapshot stays', () => {
    const dir = tempDir()
    put(dir, '__snapshots__/a.test.ts.snap', snapText({ 't 1': '1' }))
    const state = stateIn(dir, { update: 'all' })
    const result = state.match({ testName: 't', received: 2, isInline: false, testFailing: true })
    assert.equal(result.pass, false)
    assert.equal(state.updated, 0)
    assert.equal(state.unmatched, 0)
    const report = state.finish()
    assert.match(readFileSync(snapPath(dir), 'utf8'), /exports\[`t 1`\] = `1`;/)
    assert.equal(report.unchecked, 0)
  })
})

describe('fail', () => {
  test('moves the count on and checks the key', () => {
    const dir = tempDir()
    put(dir, '__snapshots__/a.test.ts.snap', snapText({ 't 1': '1' }))
    const state = stateIn(dir)
    assert.equal(state.fail('t'), 't 1')
    assert.equal(state.unmatched, 1)
    assert.deepEqual(state.getUncheckedKeys(), [])
    assert.equal(state.match({ testName: 't', received: 1, isInline: false }).key, 't 2')
  })
})

describe('matchRaw', () => {
  test('writes a missing file in `new` mode, compares exactly, and rewrites under `all`', () => {
    const dir = tempDir()
    const file = join(dir, 'out.txt')
    const state = stateIn(dir)
    assert.equal(
      state.matchRaw({ testName: 't', received: 'hello', file, existing: undefined }).pass,
      true,
    )
    state.finish()
    assert.equal(readFileSync(file, 'utf8'), 'hello')

    const none = stateIn(dir, { update: 'none' })
    assert.equal(
      none.matchRaw({ testName: 't', received: 'hello', file, existing: 'hello' }).pass,
      true,
    )
    const other = none.matchRaw({ testName: 't', received: 'hello!', file, existing: 'hello' })
    assert.equal(other.pass, false)
    assert.equal(other.expected, 'hello')

    const all = stateIn(dir, { update: 'all' })
    assert.equal(
      all.matchRaw({ testName: 't', received: 'new', file, existing: 'hello' }).pass,
      true,
    )
    assert.equal(all.updated, 1)
    all.finish()
    assert.equal(readFileSync(file, 'utf8'), 'new')
  })

  test('a non-string value is serialized first', () => {
    const dir = tempDir()
    const file = join(dir, 'out.json')
    const state = stateIn(dir)
    state.matchRaw({ testName: 't', received: { a: 1 }, file, existing: undefined })
    state.finish()
    assert.equal(readFileSync(file, 'utf8'), '{\n  "a": 1\n}')
  })
})
