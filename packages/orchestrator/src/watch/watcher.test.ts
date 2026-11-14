// The watcher on a real temp tree and real `fs.watch`: write, change, rename, unlink, a new
// directory, and what it leaves out, in both modes (one recursive watch per root, and one watch per
// directory, Linux's, forced by `perDirectory` so every platform runs it). Some sandboxes refuse
// `fs.watch` (macOS's denies FSEvents: the watch errors with EMFILE once it starts); the probe below
// finds out once, the tests skip saying why, and with `CI` set they refuse to skip.
import assert from 'node:assert/strict'
import { watch } from 'node:fs'
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { after, describe, test } from 'node:test'
import type { WatchEvent } from './coalesce.ts'
import { createWatcher, type Watcher, type WatchFunction } from './watcher.ts'

/** How long one event may take to arrive: a bound for a broken watcher, never a wait that passes. */
const EVENT_DEADLINE_MS = 5000

const dirs: string[] = []
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function tempTree(files: Readonly<Record<string, string>> = {}): Promise<string> {
  // The real path: macOS's `$TMPDIR` is under a symlink, and the events name real paths.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'provino-watch-')))
  dirs.push(dir)
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true })
    await writeFile(join(dir, path), text)
  }
  return dir
}

/**
 * Whether `fs.watch` delivers an event here, in the mode asked for: a watch that errors (EMFILE),
 * or that never says a thing about a file written under it, can't be tested.
 */
async function probe(recursive: boolean): Promise<string | undefined> {
  const dir = await tempTree()
  return new Promise((resolve) => {
    let handle: ReturnType<typeof watch> | undefined
    const done = (reason: string | undefined): void => {
      clearTimeout(timer)
      handle?.close()
      resolve(reason)
    }
    const timer = setTimeout(
      () => done(`fs.watch (recursive: ${recursive}) reported no event`),
      EVENT_DEADLINE_MS,
    )
    try {
      handle = watch(dir, { recursive }, () => done(undefined))
      handle.on('error', (error) =>
        done(`fs.watch (recursive: ${recursive}) failed: ${error.message}`),
      )
      void writeFile(join(dir, 'probe.txt'), 'x')
    } catch (error) {
      done(`fs.watch (recursive: ${recursive}) threw: ${(error as Error).message}`)
    }
  })
}

/** The probe's verdict for a mode: `undefined` runs the tests, a string skips them, naming why. */
async function skipReason(recursive: boolean): Promise<string | false> {
  const reason = await probe(recursive)
  if (reason === undefined) return false
  if (process.env.CI !== undefined && process.env.CI !== '') {
    throw new Error(`${reason}, and in CI the watcher tests must run`)
  }
  return `${reason} (a sandbox that denies file events); CI runs these`
}

/** A watcher whose events a test waits for one by one. */
async function watched(root: string, perDirectory: boolean) {
  const events: WatchEvent[] = []
  const errors: unknown[] = []
  let wake: (() => void) | undefined
  const watcher: Watcher = await createWatcher({
    roots: [root],
    keeps: (path) => path.endsWith('.ts'),
    perDirectory,
    onEvent: (event) => {
      events.push(event)
      wake?.()
    },
    onError: (error) => {
      errors.push(error)
      wake?.()
    },
  })
  /** Waits until an event matches, and returns it; every event before it is dropped. */
  async function next(kind: WatchEvent['kind'], path: string): Promise<WatchEvent> {
    const deadline = Date.now() + EVENT_DEADLINE_MS
    for (;;) {
      assert.deepEqual(errors, [])
      const at = events.findIndex((event) => event.kind === kind && event.path === path)
      if (at >= 0) {
        const [found] = events.splice(0, at + 1).slice(-1)
        if (found !== undefined) return found
      }
      const left = deadline - Date.now()
      if (left <= 0) {
        throw new Error(`no ${kind} of ${path}; saw ${JSON.stringify(events)}`)
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left)
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
  }
  return { watcher, events, errors, next }
}

for (const perDirectory of [false, true]) {
  const mode = perDirectory ? 'one watch per directory' : 'one recursive watch per root'
  describe(`the watcher, ${mode}`, async () => {
    const skip = await skipReason(!perDirectory)
    test('knows the files the walk found, and leaves out node_modules and files it does not keep', {
      skip,
    }, async () => {
      const root = await tempTree({
        'a.ts': 'a',
        'src/b.ts': 'b',
        'notes.md': 'n',
        'node_modules/dep/index.ts': 'd',
      })
      const { watcher } = await watched(root, perDirectory)
      try {
        assert.deepEqual([...watcher.known.keys()].sort(), [
          join(root, 'a.ts'),
          join(root, 'src/b.ts'),
        ])
        if (perDirectory) {
          assert.equal(watcher.handles(), 2, 'the root and src; node_modules holds no watch')
        } else assert.equal(watcher.handles(), 1)
      } finally {
        watcher.close()
      }
    })

    test('an added, changed, renamed and removed file, and a new directory with a file in it', {
      skip,
    }, async () => {
      const root = await tempTree({ 'a.ts': 'one' })
      const { watcher, next, events } = await watched(root, perDirectory)
      try {
        const a = join(root, 'a.ts')
        await writeFile(a, 'two')
        const changed = await next('change', a)
        assert.equal(typeof changed.mtimeMs, 'number')

        const b = join(root, 'b.ts')
        await writeFile(b, 'new')
        await next('add', b)

        const c = join(root, 'c.ts')
        await rename(b, c)
        await next('add', c)
        assert.ok(!watcher.known.has(b), 'the old name is gone')

        await rm(a)
        await next('unlink', a)

        const deep = join(root, 'lib', 'deep', 'd.ts')
        await mkdir(join(root, 'lib', 'deep'), { recursive: true })
        await writeFile(deep, 'd')
        await next('add', deep)
        if (perDirectory) assert.equal(watcher.handles(), 3, 'the root, lib and lib/deep')

        await writeFile(join(root, 'ignored.md'), 'x')
        await mkdir(join(root, 'node_modules'), { recursive: true })
        await writeFile(join(root, 'node_modules', 'x.ts'), 'x')
        // A kept file written last: once it is seen, the two before it would have been too.
        const last = join(root, 'last.ts')
        await writeFile(last, 'l')
        await next('add', last)
        assert.ok(
          events.every(
            (event) =>
              !event.path.endsWith('.md') && !event.path.includes(`${sep}node_modules${sep}`),
          ),
        )

        await rm(join(root, 'lib'), { recursive: true })
        await next('unlink', deep)
      } finally {
        watcher.close()
      }
    })
  })
}

/**
 * A `WatchFunction` the test drives: `raw(path)` delivers what the operating system would after a
 * change to `path` (the name relative to the root under a recursive watch, the base name to the
 * parent's watch otherwise), so the watcher's own logic runs here even where `fs.watch` can't.
 */
function fakeWatch() {
  const open = new Map<
    string,
    {
      readonly recursive: boolean
      readonly listener: (name: string | null) => void
      readonly onError: (error: Error) => void
    }
  >()
  const watchFunction: WatchFunction = (path, recursive, listener, onError) => {
    open.set(path, { recursive, listener, onError })
    return { close: () => open.delete(path) }
  }
  function raw(path: string): void {
    for (const [watched, { recursive, listener }] of open) {
      if (recursive && path.startsWith(watched + sep)) listener(relative(watched, path))
      if (!recursive && dirname(path) === watched) listener(basename(path))
    }
  }
  return { open, watchFunction, raw }
}

for (const perDirectory of [false, true]) {
  const mode = perDirectory ? 'one watch per directory' : 'one recursive watch per root'
  describe(`the watcher's events from what it is told, ${mode}`, () => {
    async function start(files: Readonly<Record<string, string>>) {
      const root = await tempTree(files)
      const fake = fakeWatch()
      const events: WatchEvent[] = []
      const errors: unknown[] = []
      const watcher = await createWatcher({
        roots: [root],
        keeps: (path) => path.endsWith('.ts'),
        perDirectory,
        watch: fake.watchFunction,
        onEvent: (event) => events.push(event),
        onError: (error) => errors.push(error),
      })
      /** What the watcher reports once the operating system names these paths. */
      const told = async (...paths: string[]): Promise<string[]> => {
        for (const path of paths) fake.raw(path)
        await watcher.settled()
        return events.splice(0).map((event) => `${event.kind} ${relative(root, event.path)}`)
      }
      return { root, fake, watcher, told, errors }
    }

    test('opens its watches where the mode says, never in node_modules or a VCS directory', async () => {
      const { root, fake, watcher } = await start({
        'a.ts': 'a',
        'src/b.ts': 'b',
        'node_modules/dep/index.ts': 'd',
        '.hg/x.ts': 'h',
      })
      try {
        assert.deepEqual(
          [...fake.open.keys()].sort(),
          perDirectory ? [root, join(root, 'src')] : [root],
        )
        assert.equal(fake.open.get(root)?.recursive, !perDirectory)
        assert.deepEqual([...watcher.known.keys()].sort(), [
          join(root, 'a.ts'),
          join(root, 'src/b.ts'),
        ])
      } finally {
        watcher.close()
      }
      assert.equal(fake.open.size, 0, 'close closes every watch')
    })

    test('a change, an add, a rename and an unlink, from lstat and what it knew', async () => {
      const { root, watcher, told } = await start({ 'a.ts': 'one', 'notes.md': 'n' })
      try {
        await writeFile(join(root, 'a.ts'), 'two')
        assert.deepEqual(await told(join(root, 'a.ts')), ['change a.ts'])
        await writeFile(join(root, 'b.ts'), 'new')
        assert.deepEqual(await told(join(root, 'b.ts')), ['add b.ts'])
        await rename(join(root, 'b.ts'), join(root, 'c.ts'))
        assert.deepEqual(await told(join(root, 'b.ts'), join(root, 'c.ts')), [
          'unlink b.ts',
          'add c.ts',
        ])
        await rm(join(root, 'a.ts'))
        assert.deepEqual(await told(join(root, 'a.ts')), ['unlink a.ts'])
        await writeFile(join(root, 'notes.md'), 'm')
        assert.deepEqual(await told(join(root, 'notes.md')), [], 'a file it does not keep')
        assert.deepEqual(await told(join(root, 'gone.ts')), [], 'a path it never knew, not there')
      } finally {
        watcher.close()
      }
    })

    test('a new directory adds its files (and its watches), and removing it unlinks them', async () => {
      const { root, fake, watcher, told } = await start({ 'a.ts': 'a' })
      try {
        await mkdir(join(root, 'lib', 'deep'), { recursive: true })
        await writeFile(join(root, 'lib', 'deep', 'd.ts'), 'd')
        await writeFile(join(root, 'lib', 'e.ts'), 'e')
        assert.deepEqual((await told(join(root, 'lib'))).sort(), [
          'add lib/deep/d.ts',
          'add lib/e.ts',
        ])
        if (perDirectory) {
          assert.deepEqual([...fake.open.keys()].sort(), [
            root,
            join(root, 'lib'),
            join(root, 'lib', 'deep'),
          ])
        }
        await writeFile(join(root, 'lib', 'deep', 'd.ts'), 'changed')
        assert.deepEqual(await told(join(root, 'lib', 'deep', 'd.ts')), ['change lib/deep/d.ts'])
        await rm(join(root, 'lib'), { recursive: true })
        assert.deepEqual((await told(join(root, 'lib'))).sort(), [
          'unlink lib/deep/d.ts',
          'unlink lib/e.ts',
        ])
        if (perDirectory) assert.deepEqual([...fake.open.keys()], [root], 'its watches are closed')
        await mkdir(join(root, 'node_modules', 'dep'), { recursive: true })
        await writeFile(join(root, 'node_modules', 'dep', 'x.ts'), 'x')
        assert.deepEqual(
          await told(join(root, 'node_modules'), join(root, 'node_modules', 'dep', 'x.ts')),
          [],
          'node_modules is never entered or reported',
        )
      } finally {
        watcher.close()
      }
    })

    test('an error on a directory that is gone closes its watch; any other error is reported', async () => {
      const { root, fake, watcher, errors } = await start({ 'lib/a.ts': 'a' })
      try {
        const lib = join(root, 'lib')
        if (perDirectory) {
          await rm(lib, { recursive: true })
          fake.open.get(lib)?.onError(new Error('the directory went away'))
          await watcher.settled()
          assert.deepEqual(errors, [])
          assert.equal(fake.open.has(lib), false)
        }
        const failure = Object.assign(new Error('too many open files'), { code: 'EMFILE' })
        fake.open.get(root)?.onError(failure)
        await watcher.settled()
        assert.deepEqual(errors, [failure])
      } finally {
        watcher.close()
      }
    })

    test('an event that names no file looks at the whole directory again', {
      skip: perDirectory ? false : 'a recursive watch that names no file has nothing to look at',
    }, async () => {
      const { root, fake, watcher } = await start({ 'a.ts': 'a', 'b.ts': 'b' })
      try {
        await rm(join(root, 'a.ts'))
        await writeFile(join(root, 'c.ts'), 'c')
        fake.open.get(root)?.listener(null)
        await watcher.settled()
        assert.deepEqual([...watcher.known.keys()].map((path) => relative(root, path)).sort(), [
          'b.ts',
          'c.ts',
        ])
      } finally {
        watcher.close()
      }
    })
  })
}
