import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { errorMessage, readIfExists } from './guards.ts'

test('errorMessage is an Error’s message, else the value as text', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom')
  assert.equal(errorMessage(new TypeError('bad type')), 'bad type')
  assert.equal(errorMessage('plain'), 'plain')
  assert.equal(errorMessage(42), '42')
  assert.equal(errorMessage(undefined), 'undefined')
  assert.equal(errorMessage({ code: 'ENOENT' }), '[object Object]')
})

test('readIfExists reads a file, returns undefined for a missing one, and throws anything else', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'harness-guards-'))
  try {
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'text\n')
    assert.equal(await readIfExists(file), 'text\n')
    await writeFile(path.join(dir, 'empty.txt'), '')
    assert.equal(await readIfExists(path.join(dir, 'empty.txt')), '')
    assert.equal(await readIfExists(path.join(dir, 'missing.txt')), undefined)
    // A directory exists but can't be read as a file: not "missing".
    await assert.rejects(
      readIfExists(dir),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EISDIR',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
