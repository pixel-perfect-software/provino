import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { code, scratch } from '../internal/test-helpers.ts'
import { assertEmptiable, prepareWork, WORK_MARKER } from './prepare.ts'

test('a work directory that holds something this command did not make is refused, and left alone', async (t) => {
  const dir = await scratch(t, 'provino-prepare-')
  await writeFile(join(dir, 'precious.txt'), 'keep\n')
  await assert.rejects(() => assertEmptiable(dir), code('BENCH_USAGE'))
  // `prepareWork` checks again, so a caller that skipped the early check still deletes nothing.
  await assert.rejects(() => prepareWork(dir), code('BENCH_USAGE'))
  assert.equal(await readFile(join(dir, 'precious.txt'), 'utf8'), 'keep\n')
  assert.deepEqual(await readdir(dir), ['precious.txt'])
})

test('a missing, an empty and a directory it made itself may be emptied', async (t) => {
  const dir = await scratch(t, 'provino-prepare-')
  await assertEmptiable(join(dir, 'not-yet'))
  await mkdir(join(dir, 'empty'))
  await assertEmptiable(join(dir, 'empty'))
  // One earlier run wrote its marker (and then whatever the legs left beside it).
  await mkdir(join(dir, 'earlier'))
  await writeFile(join(dir, 'earlier', WORK_MARKER), 'made by a run\n')
  await writeFile(join(dir, 'earlier', 'left-over'), 'x\n')
  await assertEmptiable(join(dir, 'earlier'))
})
