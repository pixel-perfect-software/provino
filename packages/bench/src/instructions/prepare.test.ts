import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BenchError } from '../errors.ts'
import { assertEmptiable, prepareWork, WORK_MARKER } from './prepare.ts'

const isUsage = (error: unknown): boolean =>
  error instanceof BenchError && error.code === 'BENCH_USAGE'

async function inTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'provino-prepare-'))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a work directory that holds something this command did not make is refused, and left alone', async () => {
  await inTempDir(async (dir) => {
    await writeFile(join(dir, 'precious.txt'), 'keep\n')
    await assert.rejects(() => assertEmptiable(dir), isUsage)
    // `prepareWork` checks again, so a caller that skipped the early check still deletes nothing.
    await assert.rejects(() => prepareWork(dir), isUsage)
    assert.equal(await readFile(join(dir, 'precious.txt'), 'utf8'), 'keep\n')
    assert.deepEqual(await readdir(dir), ['precious.txt'])
  })
})

test('a missing, an empty and a directory it made itself may be emptied', async () => {
  await inTempDir(async (dir) => {
    await assertEmptiable(join(dir, 'not-yet'))
    await mkdir(join(dir, 'empty'))
    await assertEmptiable(join(dir, 'empty'))
    // One earlier run wrote its marker (and then whatever the legs left beside it).
    await mkdir(join(dir, 'earlier'))
    await writeFile(join(dir, 'earlier', WORK_MARKER), 'made by a run\n')
    await writeFile(join(dir, 'earlier', 'left-over'), 'x\n')
    await assertEmptiable(join(dir, 'earlier'))
  })
})
