import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { HarnessError } from '../errors.ts'
import { createWorkDirRegistry, resolveRecordRoot } from './work-dirs.ts'

async function withTempDir(use: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'harness-work-dirs-'))
  try {
    await use(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** A directory with a file in it, as a recorder's work directory has. */
async function workDir(parent: string, name: string): Promise<string> {
  const dir = path.join(parent, name)
  await mkdir(path.join(dir, '.harness-out'), { recursive: true })
  await writeFile(path.join(dir, '.harness-out', 'trace.txt'), 'step\n')
  return dir
}

test('a tracked directory is removed when the process exits', async () => {
  await withTempDir(async (tmp) => {
    const target = new EventEmitter()
    const registry = createWorkDirRegistry({ target })
    const dir = await workDir(tmp, 'a')
    registry.track(dir)
    assert.ok(existsSync(dir))
    target.emit('exit')
    assert.equal(existsSync(dir), false)
    assert.equal(target.listenerCount('exit'), 0)
  })
})

test('a forgotten directory stays, and the registry stops listening', async () => {
  await withTempDir(async (tmp) => {
    const target = new EventEmitter()
    const registry = createWorkDirRegistry({ target })
    const dir = await workDir(tmp, 'a')
    registry.track(dir)
    registry.forget(dir)
    assert.equal(target.listenerCount('exit'), 0)
    target.emit('exit')
    assert.ok(existsSync(dir))
  })
})

test('one listener serves every directory, and goes with the last one', async () => {
  await withTempDir(async (tmp) => {
    const target = new EventEmitter()
    const registry = createWorkDirRegistry({ target })
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((name) => workDir(tmp, name)))
    assert.ok(a !== undefined && b !== undefined && c !== undefined)
    registry.track(a)
    registry.track(b)
    registry.track(b)
    registry.track(c)
    assert.equal(target.listenerCount('exit'), 1)
    registry.forget(a)
    registry.forget(a)
    assert.equal(target.listenerCount('exit'), 1)
    target.emit('exit')
    assert.deepEqual([existsSync(a), existsSync(b), existsSync(c)], [true, false, false])
    // Tracking after an exit works the same way: this registry is not used up.
    registry.track(a)
    assert.equal(target.listenerCount('exit'), 1)
    registry.forget(a)
    assert.equal(target.listenerCount('exit'), 0)
  })
})

test('a directory that is already gone is not a problem', async () => {
  await withTempDir(async (tmp) => {
    const target = new EventEmitter()
    const reports: string[] = []
    const registry = createWorkDirRegistry({ target, report: (message) => reports.push(message) })
    registry.track(path.join(tmp, 'never-made'))
    target.emit('exit')
    assert.deepEqual(reports, [])
  })
})

test('a directory that cannot be removed is reported, and the others are still removed', () => {
  const target = new EventEmitter()
  const removed: string[] = []
  const reports: string[] = []
  const registry = createWorkDirRegistry({
    target,
    remove: (dir) => {
      if (dir === '/work/stuck') throw new Error('EBUSY')
      removed.push(dir)
    },
    report: (message) => reports.push(message),
  })
  for (const dir of ['/work/a', '/work/stuck', '/work/b']) registry.track(dir)
  target.emit('exit')
  assert.deepEqual(removed, ['/work/a', '/work/b'])
  assert.equal(reports.length, 1)
  assert.match(reports[0] ?? '', /\/work\/stuck.*EBUSY/)
})

// The case this module exists for: SIGTERM reaches `exitOnSignals`, which calls `process.exit`
// and skips every `catch`; only the `exit` listener is left to clean up.
test('a process ended by SIGTERM through exitOnSignals leaves no tracked directory behind', async () => {
  await withTempDir(async (tmp) => {
    const dir = await workDir(tmp, 'tracked')
    const module = (file: string): string => JSON.stringify(new URL(file, import.meta.url).href)
    const script = `
      import { createWorkDirRegistry } from ${module('./work-dirs.ts')}
      import { exitOnSignals } from ${module('../spawn-in-group.ts')}
      createWorkDirRegistry().track(process.argv[1])
      exitOnSignals()
      console.log('ready')
      setInterval(() => {}, 1000)
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    try {
      const [chunk] = await once(child.stdout, 'data')
      assert.match(String(chunk), /ready/)
      assert.ok(existsSync(dir))
      child.kill('SIGTERM')
      const [code, signal] = await once(child, 'exit')
      assert.equal(signal, null, 'exitOnSignals turns the signal into a normal exit')
      assert.equal(code, 128 + 15)
      assert.equal(existsSync(dir), false)
    } finally {
      child.kill('SIGKILL')
    }
  })
})

test('resolveRecordRoot refuses a relative root and resolves a symlinked one to its real path', async () => {
  assert.equal(resolveRecordRoot(undefined, '/fallback'), '/fallback')
  assert.throws(
    () => resolveRecordRoot('relative/root', '/fallback'),
    (error: unknown) => error instanceof HarnessError && error.code === 'HARNESS_BAD_RECORD_ROOT',
  )
  await withTempDir(async (tmp) => {
    const real = await realpath(await workDir(tmp, 'real'))
    const link = path.join(tmp, 'link')
    await symlink(real, link)
    assert.equal(resolveRecordRoot(link, '/fallback'), real)
    assert.equal(resolveRecordRoot(path.join(link, '..', 'real', 'x', '..'), '/fallback'), real)
    assert.equal(
      resolveRecordRoot(path.join(real, 'missing'), '/fallback'),
      path.join(real, 'missing'),
    )
  })
})
