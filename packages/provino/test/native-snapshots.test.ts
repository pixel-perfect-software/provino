// Native snapshots end to end (B28, D211): a project with no dialect writes and compares `.snap`
// files in Jest 30.5's format through `provino run`, on the built bin (forks and threads) and the
// source bin. The bytes are Provino's here; `@provino/harness`'s `snapshot-corpus.test.ts` holds
// them to real Jest's recordings (its `native` profile). The runs of one project follow each other:
// write, match, CI with a changed value, `-u`.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'provino'
import {
  type BinKind,
  nativeProject,
  nativeRunArgs,
  readLoadLogs,
  runBin,
  runBuilt,
  scratch,
  viewOfNormalized,
} from './support.ts'

const SNAPSHOTS = `import { describe, expect, it } from 'provino'

describe('native snapshots', () => {
  it('writes a value', () => {
    expect({ a: [1, 'two'], b: new Map([['k', 1]]) }).toMatchSnapshot()
  })

  it('takes a hint', () => {
    expect('line one\\nline two').toMatchSnapshot('lines')
  })

  it('stores a thrown message', () => {
    expect(() => {
      throw new Error('boom')
    }).toThrowErrorMatchingSnapshot()
  })

  it('compares an inline snapshot', async () => {
    expect(3).toMatchInlineSnapshot('3')
    await expect(Promise.reject(new Error('nope'))).rejects.toThrowErrorMatchingInlineSnapshot('"nope"')
  })
})
`

/** What the first run writes: Jest's header, keys and printing. */
const WRITTEN = `// Jest Snapshot v1, https://jestjs.io/docs/snapshot-testing

exports[\`native snapshots stores a thrown message 1\`] = \`"boom"\`;

exports[\`native snapshots takes a hint: lines 1\`] = \`
"line one
line two"
\`;

exports[\`native snapshots writes a value 1\`] = \`
{
  "a": [
    1,
    "two",
  ],
  "b": Map {
    "k" => 1,
  },
}
\`;
`

const SNAP = join('tests', '__snapshots__', 'snap.test.ts.snap')

/** Each test's status, by its path. */
async function statuses(dir: string): Promise<ReadonlyMap<string, unknown>> {
  const view = viewOfNormalized(await readFile(join(dir, 'results.json'), 'utf8'))
  const found = new Map<string, unknown>()
  for (const file of view.files.values()) {
    assert.equal(file.fileError, undefined, file.fileError)
    for (const [name, status] of file.tests) found.set(name, status)
  }
  return found
}

const ALL_PASS = new Map([
  ['native snapshots > writes a value', 'passed'],
  ['native snapshots > takes a hint', 'passed'],
  ['native snapshots > stores a thrown message', 'passed'],
  ['native snapshots > compares an inline snapshot', 'passed'],
])

type Run = (
  args: readonly string[],
  dir: string,
) => Promise<{ status: number | null; output: string }>

const on =
  (kind: BinKind): Run =>
  async (args, dir) => {
    const run = await runBin(kind, args, { cwd: dir })
    return { status: run.status, output: `${run.stdout}\n${run.stderr}` }
  }
const built = on('built')
const source = on('source')

/** Write, match, fail in CI on a changed value without writing, then rewrite with `-u`. */
async function lifecycle(run: Run, pool: string): Promise<void> {
  const dir = await nativeProject({ 'tests/snap.test.ts': SNAPSHOTS })
  const args = nativeRunArgs(pool)

  const first = await run(args, dir)
  assert.equal(first.status, 0, first.output)
  assert.deepEqual(await statuses(dir), ALL_PASS)
  assert.equal(await readFile(join(dir, SNAP), 'utf8'), WRITTEN)

  const second = await run([...args, '--ci'], dir)
  assert.equal(second.status, 0, second.output)
  assert.deepEqual(await statuses(dir), ALL_PASS)
  assert.equal(await readFile(join(dir, SNAP), 'utf8'), WRITTEN)

  const changed = SNAPSHOTS.replace("throw new Error('boom')", "throw new Error('bang')")
  await writeFile(join(dir, 'tests', 'snap.test.ts'), changed)
  const failed = await run([...args, '--ci'], dir)
  assert.equal(failed.status, 1, failed.output)
  assert.equal((await statuses(dir)).get('native snapshots > stores a thrown message'), 'failed')
  assert.equal(await readFile(join(dir, SNAP), 'utf8'), WRITTEN, 'a failed snapshot is not written')

  const updated = await run([...args, '-u'], dir)
  assert.equal(updated.status, 0, updated.output)
  assert.equal(await readFile(join(dir, SNAP), 'utf8'), WRITTEN.replace('`"boom"`', '`"bang"`'))
}

describe('native snapshots through provino run', () => {
  for (const pool of ['forks', 'threads'] as const) {
    test(`built bin, --pool ${pool}`, () => lifecycle(built, pool))
  }
  test('source bin, --pool forks', () => lifecycle(source, 'forks'))

  test('a worker that writes a snapshot loads the vendored printer', async () => {
    const dir = await nativeProject({ 'tests/snap.test.ts': SNAPSHOTS })
    const logs = scratch('provino-native-snapshot-loads-')
    const run = runBuilt(nativeRunArgs('forks'), {
      cwd: dir,
      preloads: ['load-recorder'],
      env: { PROVINO_LOAD_LOG: logs },
    })
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
    const loaded = readLoadLogs(logs).flatMap(({ urls }) => urls)
    assert.ok(
      loaded.some((url) => url.endsWith('/dist/worker/snapshot-printer-impl.js')),
      loaded.join('\n'),
    )
    // Nothing was written into a source file, so no process loaded the inline writer.
    assert.ok(
      !loaded.some((url) => url.endsWith('/dist/worker/snapshot-inline.js')),
      loaded.join('\n'),
    )
  })

  test('an inline snapshot with nothing stored is written into the test file, by the inline writer (B28 Phase 7)', async () => {
    const file =
      "import { expect, it } from 'provino'\nit('new', () => { expect({ a: 1 }).toMatchInlineSnapshot() })\n"
    const dir = await nativeProject({ 'tests/inline.test.ts': file })
    const logs = scratch('provino-native-inline-loads-')
    const run = runBuilt(nativeRunArgs('forks'), {
      cwd: dir,
      preloads: ['load-recorder'],
      env: { PROVINO_LOAD_LOG: logs },
    })
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
    assert.equal((await statuses(dir)).get('new'), 'passed')
    assert.equal(
      await readFile(join(dir, 'tests', 'inline.test.ts'), 'utf8'),
      "import { expect, it } from 'provino'\nit('new', () => { expect({ a: 1 }).toMatchInlineSnapshot(`\n{\n  \"a\": 1,\n}\n`) })\n",
    )
    const loaded = readLoadLogs(logs).flatMap(({ urls }) => urls)
    assert.ok(
      loaded.some((url) => url.endsWith('/dist/worker/snapshot-inline.js')),
      loaded.join('\n'),
    )
    // A second run matches what the first wrote, and writes nothing.
    const again = await built([...nativeRunArgs('forks'), '--ci'], dir)
    assert.equal(again.status, 0, again.output)
  })

  test('a helper two test files write into is never written from out-of-date positions (B28 Phase 7)', async () => {
    // `a` on line 2, `b` (holding a snapshot) on line 3, `d` on line 7. x's multi-line snapshot
    // puts four more lines after line 2, so y's line 7, from the text before, is `b` afterwards.
    const helper = [
      "import { expect } from 'provino'",
      'export const a = (v: unknown): void => { expect(v).toMatchInlineSnapshot() }',
      'export const b = (v: unknown): void => { expect(v).toMatchInlineSnapshot(`"keep"`) }',
      '// filler 1',
      '// filler 2',
      '// filler 3',
      'export const d = (v: unknown): void => { expect(v).toMatchInlineSnapshot() }',
      '',
    ].join('\n')
    const dir = await nativeProject({
      'tests/helper.ts': helper,
      // The larger file runs first, so its write is the one the other file's positions predate.
      'tests/x.test.ts': `import { it } from 'provino'\nimport { a } from './helper.ts'\n${'// x\n'.repeat(40)}it('x', () => { a({ a: 1 }) })\n`,
      'tests/y.test.ts':
        "import { it } from 'provino'\nimport { d } from './helper.ts'\nit('y', () => { d('NEW') })\n",
    })
    const read = () => readFile(join(dir, 'tests', 'helper.ts'), 'utf8')
    // One worker runs both files, so the second runs on the helper as the worker first loaded it.
    const first = await built(nativeRunArgs('forks'), dir)
    assert.match(await read(), /b = .*toMatchInlineSnapshot\(`"keep"`\)/, first.output)
    // The worker's helper is still the text from before the first file's write, so the second
    // file's edit is refused: its file fails, saying to re-run.
    assert.equal(first.status, 1, first.output)
    const view = viewOfNormalized(await readFile(join(dir, 'results.json'), 'utf8'))
    const refused = [...view.files.values()].flatMap((file) =>
      file.fileError === undefined ? [] : [file.fileError],
    )
    assert.equal(refused.length, 1, first.output)
    assert.match(String(refused[0]), /out of date\. Run the tests again to write them/)
    // Each run writes what the one before refused, until both are in.
    const second = await built(nativeRunArgs('forks'), dir)
    assert.equal(second.status, 0, second.output)
    assert.equal(
      await read(),
      helper
        .replace('toMatchInlineSnapshot() }', 'toMatchInlineSnapshot(`\n{\n  "a": 1,\n}\n`) }')
        .replace('toMatchInlineSnapshot() }', 'toMatchInlineSnapshot(`"NEW"`) }'),
    )
    const ci = await built([...nativeRunArgs('forks'), '--ci'], dir)
    assert.equal(ci.status, 0, ci.output)
  })
})
