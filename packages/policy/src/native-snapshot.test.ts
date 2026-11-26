import assert from 'node:assert/strict'
import type { InlineSnapshotWriterFactory, SnapshotPrinterFactory } from '@provino/types'
import { test } from 'provino'
import { moduleRef } from './module-ref.ts'
import { nativeSnapshotPolicy } from './native-snapshot.ts'
import { neutralPolicy } from './neutral.ts'
import { resolvePolicy } from './resolve.ts'
import { serializePolicy } from './serialize.ts'

// The format values are held equal to Jest's by `@provino/harness`'s
// `native-snapshot-values.test.ts` (NN2); here, what the layer does to the neutral slice.
const printer = moduleRef<SnapshotPrinterFactory>(
  'file:///native/printer.mjs',
  'nativeSnapshotPrinter',
)
const writer = moduleRef<InlineSnapshotWriterFactory>(
  'file:///native/writer.mjs',
  'nativeInlineSnapshotWriter',
)

test('the printer and the writer are the refs given', () => {
  const { snapshot } = resolvePolicy({
    snapshot: nativeSnapshotPolicy({ snapshotPrinter: printer, snapshotWriter: writer }),
  })
  assert.deepEqual(snapshot.printer, printer)
  assert.deepEqual(snapshot.inline.writer, writer)
})

test('without a writer an inline snapshot has none, and the other inline keys stay neutral', () => {
  const { snapshot } = resolvePolicy({
    snapshot: nativeSnapshotPolicy({ snapshotPrinter: printer }),
  })
  assert.equal(snapshot.inline.writer, null)
  const { writer: _writer, ...rest } = snapshot.inline
  const { writer: _neutral, ...neutralRest } = neutralPolicy.snapshot.inline
  assert.deepEqual(rest, neutralRest)
})

test('it changes only the format keys, the printer and the writer', () => {
  const layer = nativeSnapshotPolicy({ snapshotPrinter: printer })
  assert.deepEqual(Object.keys(layer).sort(), [
    'format',
    'header',
    'hintJoin',
    'inline',
    'keyJoin',
    'printer',
  ])
  const { snapshot } = resolvePolicy({ snapshot: layer })
  for (const key of Object.keys(neutralPolicy.snapshot) as (keyof typeof snapshot)[]) {
    if (Object.hasOwn(layer, key)) continue
    assert.deepEqual(snapshot[key], neutralPolicy.snapshot[key], key)
  }
})

test('the resolved policy serializes (it crosses to a worker)', () => {
  const policy = resolvePolicy({ snapshot: nativeSnapshotPolicy({ snapshotPrinter: printer }) })
  assert.deepEqual(serializePolicy(policy).snapshot.printer, printer)
})
