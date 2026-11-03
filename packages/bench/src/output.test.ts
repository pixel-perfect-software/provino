import assert from 'node:assert/strict'
import { access, chmod, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { BenchError } from './errors.ts'
import { code, scratch } from './internal/test-helpers.ts'
import { prepareOutput, writeRecordFile } from './output.ts'

test('a free path is accepted and its directory is created', async (t) => {
  const dir = await scratch(t, 'bench-out-')
  await prepareOutput(join(dir, 'a', 'b', 'run.json'))
  assert.deepEqual(await readdir(join(dir, 'a', 'b')), [])
})

test('an existing file, directory or link is refused, whatever it holds', async (t) => {
  const dir = await scratch(t, 'bench-out-')
  await writeFile(join(dir, 'file'), '')
  await mkdir(join(dir, 'directory'))
  await symlink(join(dir, 'missing-target'), join(dir, 'dangling'))
  await assert.rejects(prepareOutput(join(dir, 'file')), code('BENCH_OUT_INVALID'))
  await assert.rejects(prepareOutput(join(dir, 'directory')), code('BENCH_OUT_INVALID'))
  await assert.rejects(prepareOutput(join(dir, 'dangling')), code('BENCH_OUT_INVALID'))
  assert.equal(await readFile(join(dir, 'file'), 'utf8'), '')
})

test('a path under a file is refused', async (t) => {
  const dir = await scratch(t, 'bench-out-')
  await writeFile(join(dir, 'file'), '')
  await assert.rejects(prepareOutput(join(dir, 'file', 'run.json')), code('BENCH_OUT_INVALID'))
})

test('a directory that cannot be written is refused', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root can write anywhere')
  const dir = await scratch(t, 'bench-out-')
  await mkdir(join(dir, 'locked'))
  await chmod(join(dir, 'locked'), 0o500)
  try {
    await assert.rejects(prepareOutput(join(dir, 'locked', 'run.json')), code('BENCH_OUT_INVALID'))
  } finally {
    await chmod(join(dir, 'locked'), 0o700)
  }
})

test('a record is written whole, with no temp file left behind', async (t) => {
  const dir = await scratch(t, 'bench-out-')
  const path = join(dir, 'run.json')
  await writeRecordFile(path, '{"ok":true}\n')
  assert.equal(await readFile(path, 'utf8'), '{"ok":true}\n')
  assert.deepEqual(await readdir(dir), ['run.json'])
})

test('an existing file is never replaced; the complete record is kept in a named temp file', async (t) => {
  const dir = await scratch(t, 'bench-out-')
  const path = join(dir, 'run.json')
  await writeFile(path, 'earlier record')
  await assert.rejects(
    writeRecordFile(path, 'new record'),
    (error) =>
      code('BENCH_OUT_WRITE_FAILED')(error) &&
      (error as BenchError).message.includes(`${path}.${process.pid}.tmp`),
  )
  assert.equal(await readFile(path, 'utf8'), 'earlier record')
  assert.equal(await readFile(`${path}.${process.pid}.tmp`, 'utf8'), 'new record')
})

test('a link at the destination is neither followed nor replaced', async (t) => {
  const dir = await scratch(t, 'bench-out-')
  const path = join(dir, 'run.json')
  await symlink(join(dir, 'elsewhere.json'), path)
  await assert.rejects(writeRecordFile(path, 'new record'), code('BENCH_OUT_WRITE_FAILED'))
  await assert.rejects(access(join(dir, 'elsewhere.json')), { code: 'ENOENT' })
  assert.equal(await readFile(`${path}.${process.pid}.tmp`, 'utf8'), 'new record')
})

test('a write that fails is a BenchError and leaves nothing behind', async (t) => {
  const dir = await scratch(t, 'bench-out-')
  const path = join(dir, 'gone', 'run.json')
  await assert.rejects(
    writeRecordFile(path, 'x'),
    (error) =>
      code('BENCH_OUT_WRITE_FAILED')(error) && (error as BenchError).cause instanceof Error,
  )
  assert.deepEqual(await readdir(dir), [])
})
