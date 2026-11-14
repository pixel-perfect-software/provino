import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type {
  InlineSnapshotEdit,
  InlineSnapshotWriteOptions,
  InlineSnapshotWriter,
} from '@provino/types'
import { createInlineSnapshotWrites, withInlineSnapshots } from './inline-snapshots.ts'
import type { PoolOutcome } from './pool.ts'

const edit = (file: string, snapshot = '1'): InlineSnapshotEdit => ({
  file,
  line: 1,
  column: 0,
  snapshot,
})

/** A writer that records what it was handed, waiting for `release` when asked to. */
function recordingWriter(options: { readonly hold?: Promise<void>; readonly fail?: string } = {}) {
  const calls: { edits: readonly InlineSnapshotEdit[]; options: InlineSnapshotWriteOptions }[] = []
  const order: string[] = []
  const writer: InlineSnapshotWriter = async (edits, writeOptions) => {
    order.push(`start ${edits[0]?.snapshot}`)
    calls.push({ edits, options: writeOptions })
    await options.hold
    order.push(`end ${edits[0]?.snapshot}`)
    if (options.fail !== undefined) throw new Error(options.fail)
    return ['a warning']
  }
  return { calls, order, factory: () => writer }
}

const done = (inline?: readonly InlineSnapshotEdit[]): PoolOutcome => ({
  type: 'done',
  workerId: 1,
  done: {
    t: 'fileDone',
    seq: 1,
    memoryBytes: 0,
    leakedHandles: 0,
    leakedGlobals: [],
    ...(inline === undefined
      ? {}
      : {
          snapshot: {
            file: null,
            added: inline.length,
            matched: 0,
            unmatched: 0,
            updated: 0,
            unchecked: 0,
            uncheckedKeys: [],
            fileDeleted: false,
            inline,
          },
        }),
  },
})

describe('inline snapshot writes (B23d B1)', () => {
  test('the writer gets the edits, the root and the policy`s prettierPath, and its warnings are said', async () => {
    const writer = recordingWriter()
    const warnings: string[] = []
    const project = {
      rootDir: '/root',
      policy: {
        inline: {
          indent: 'column0',
          formatter: 'prettier',
          writer: writer.factory,
          prettierPath: '/p/prettier.cjs',
        },
      },
      update: 'new',
    } as const
    const outcome = done([edit('/root/a.test.ts')])
    const after = await withInlineSnapshots(outcome, createInlineSnapshotWrites(), project, (w) =>
      warnings.push(w),
    )
    assert.equal(after, outcome)
    assert.deepEqual(writer.calls[0]?.options, {
      rootDir: '/root',
      prettierPath: '/p/prettier.cjs',
    })
    assert.deepEqual(writer.calls[0]?.edits, [edit('/root/a.test.ts')])
    assert.deepEqual(warnings, ['a warning'])
  })

  test('nothing is written under `none`, with no writer, or with no edits', async () => {
    const writer = recordingWriter()
    const writes = createInlineSnapshotWrites()
    const inline = {
      indent: 'column0',
      formatter: 'none',
      writer: writer.factory,
      prettierPath: null,
    } as const
    await withInlineSnapshots(
      done([edit('/a')]),
      writes,
      { rootDir: '/', policy: { inline }, update: 'none' },
      () => {},
    )
    await withInlineSnapshots(
      done(),
      writes,
      { rootDir: '/', policy: { inline }, update: 'new' },
      () => {},
    )
    await withInlineSnapshots(
      done([edit('/a')]),
      writes,
      { rootDir: '/', policy: { inline: { ...inline, writer: null } }, update: 'new' },
      () => {},
    )
    assert.equal(writer.calls.length, 0)
  })

  test('a writer that throws fails the file with its error', async () => {
    const writer = recordingWriter({
      fail: 'Jest: Multiple inline snapshots for the same call are not supported.',
    })
    const inline = {
      indent: 'column0',
      formatter: 'none',
      writer: writer.factory,
      prettierPath: null,
    } as const
    const after = await withInlineSnapshots(
      done([edit('/a')]),
      createInlineSnapshotWrites(),
      { rootDir: '/', policy: { inline }, update: 'all' },
      () => {},
    )
    assert.equal(after.type, 'failed')
    assert.match(String(after.type === 'failed' ? after.error : ''), /Multiple inline snapshots/)
  })

  test('two files that edit one source are written one after the other', async () => {
    const release = Promise.withResolvers<void>()
    const writer = recordingWriter({ hold: release.promise })
    const writes = createInlineSnapshotWrites()
    const project = {
      rootDir: '/',
      policy: {
        inline: {
          indent: 'column0',
          formatter: 'none',
          writer: writer.factory,
          prettierPath: null,
        },
      },
      update: 'new',
    } as const
    const first = withInlineSnapshots(done([edit('/shared.ts', 'one')]), writes, project, () => {})
    const second = withInlineSnapshots(done([edit('/shared.ts', 'two')]), writes, project, () => {})
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(writer.order, ['start one'])
    release.resolve()
    await Promise.all([first, second])
    assert.deepEqual(writer.order, ['start one', 'end one', 'start two', 'end two'])
  })
})
