import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inlineSourceHash, SnapshotError } from '@provino/snapshot/node'
import type {
  InlineSnapshotEdit,
  InlineSnapshotWriteOptions,
  InlineSnapshotWriter,
} from '@provino/types'
import { afterAll, describe, test } from 'provino'
import { createInlineSnapshotWrites, withInlineSnapshots } from './inline-snapshots.ts'
import type { PoolOutcome } from './pool.ts'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A fresh temp directory, removed when the file ends. */
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'provino-inline-writes-'))
  dirs.push(dir)
  return dir
}

/** The native slice's inline keys: its writer by ref, as the native policy names it. */
const nativeSnapshotInline = {
  indent: 'column0',
  formatter: 'none',
  writer: {
    module: import.meta.resolve('@provino/snapshot/inline'),
    export: 'nativeInlineSnapshotWriter',
  },
  prettierPath: null,
} as const

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
    const shared = join(scratchDir(), 'shared.ts')
    await writeFile(shared, 'unchanged\n')
    const loaded = { sourceHash: inlineSourceHash('unchanged\n') }
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
    const first = withInlineSnapshots(
      done([{ ...edit(shared, 'one'), ...loaded }]),
      writes,
      project,
      () => {},
    )
    const second = withInlineSnapshots(
      done([{ ...edit(shared, 'two'), ...loaded }]),
      writes,
      project,
      () => {},
    )
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(writer.order, ['start one'])
    release.resolve()
    await Promise.all([first, second])
    assert.deepEqual(writer.order, ['start one', 'end one', 'start two', 'end two'])
  })
})

describe('inline snapshot writes into a source another file already changed (B28 Phase 7)', () => {
  /** A helper module two test files call: `a` on line 2, `b` (with a snapshot) on 3, `d` on 7. */
  const HELPER = [
    "import { expect } from 'provino'",
    'export const a = (v: unknown): void => { expect(v).toMatchInlineSnapshot() }',
    'export const b = (v: unknown): void => { expect(v).toMatchInlineSnapshot(`"keep"`) }',
    '// filler 1',
    '// filler 2',
    '// filler 3',
    'export const d = (v: unknown): void => { expect(v).toMatchInlineSnapshot() }',
    '',
  ].join('\n')
  const project = {
    rootDir: '/',
    policy: { inline: nativeSnapshotInline },
    update: 'new',
  } as const

  /** The helper in a fresh directory, and the edit of the matcher on `line` as of `text`. */
  async function helper() {
    const file = join(scratchDir(), 'helper.ts')
    await writeFile(file, HELPER)
    const at = (
      text: string,
      line: number,
      snapshot: string,
      hashed = true,
    ): InlineSnapshotEdit => ({
      file,
      line,
      column: (text.split('\n')[line - 1] ?? '').indexOf('toMatchInlineSnapshot'),
      snapshot,
      ...(hashed ? { sourceHash: inlineSourceHash(text) } : {}),
    })
    return { file, at, read: () => readFile(file, 'utf8') }
  }

  /** What a refused file fails with. */
  function staleError(outcome: PoolOutcome): unknown {
    assert.equal(outcome.type, 'failed')
    return outcome.type === 'failed' ? outcome.error : undefined
  }

  test('an edit from the text before this run wrote the file is refused, and no other call is touched', async () => {
    const h = await helper()
    const writes = createInlineSnapshotWrites()
    // Test file X ends first: a multi-line snapshot into `a`, four lines more after line 2.
    const x = await withInlineSnapshots(
      done([h.at(HELPER, 2, '\n{\n  "a": 1,\n}\n')]),
      writes,
      project,
      () => {},
    )
    assert.equal(x.type, 'done')
    const afterX = await h.read()
    // Test file Y loaded the helper before X's write: its line 7 is `d` there, `b` now.
    const y = await withInlineSnapshots(done([h.at(HELPER, 7, '"NEW"')]), writes, project, () => {})
    const error = staleError(y)
    assert.ok(
      error instanceof SnapshotError && error.code === 'SNAPSHOT_INLINE_STALE',
      String(error),
    )
    assert.match(error.message, /Run the tests again/)
    assert.equal(await h.read(), afterX, 'nothing is written for the refused file')
    assert.match(afterX, /toMatchInlineSnapshot\(`"keep"`\)/)
  })

  test('an edit from the text this run wrote is written, and one whose worker named no text is refused', async () => {
    const h = await helper()
    const writes = createInlineSnapshotWrites()
    await withInlineSnapshots(done([h.at(HELPER, 2, '"A"')]), writes, project, () => {})
    const afterX = await h.read()
    // A file that loaded the helper after X's write: its positions are in X's text.
    const fresh = await withInlineSnapshots(
      done([h.at(afterX, 7, '"D"')]),
      writes,
      project,
      () => {},
    )
    assert.equal(fresh.type, 'done')
    const afterFresh = await h.read()
    assert.equal(
      afterFresh,
      HELPER.replace('toMatchInlineSnapshot() }', 'toMatchInlineSnapshot(`"A"`) }').replace(
        'toMatchInlineSnapshot() }',
        'toMatchInlineSnapshot(`"D"`) }',
      ),
    )
    const unnamed = await withInlineSnapshots(
      done([h.at(afterFresh, 3, '"B"', false)]),
      writes,
      project,
      () => {},
    )
    const error = staleError(unnamed)
    assert.ok(
      error instanceof SnapshotError && error.code === 'SNAPSHOT_INLINE_STALE',
      String(error),
    )
    assert.equal(await h.read(), afterFresh)
  })

  test('the first write of a file in a run takes its edits whatever text they name', async () => {
    const h = await helper()
    const after = await withInlineSnapshots(
      done([h.at(HELPER, 7, '"D"', false)]),
      createInlineSnapshotWrites(),
      project,
      () => {},
    )
    assert.equal(after.type, 'done')
    assert.match(await h.read(), /d = .*toMatchInlineSnapshot\(`"D"`\)/)
  })
})
