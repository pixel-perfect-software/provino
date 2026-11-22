// `provino run --watch` and `--watchAll` on a native project (B27k, D202), in this process: the
// command on a fake terminal (one stream for stderr with `isTTY`, a stdin with raw mode), the
// changes fed to the session and its coalescing clock fired by hand, so nothing here waits on time.
// A test waits for the run's own totals line to be written, not for a delay.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { Writable } from 'node:stream'
import { describe, it } from 'node:test'
import { Collect, makeProject, startCli, trackedProjects } from './support.ts'
import { watcherSkip } from './watch-goldens.ts'

interface WatchIo {
  readonly stdin?: unknown
  readonly changes?: unknown
  readonly clock?: unknown
}
type Main = (
  argv: readonly string[],
  io: {
    readonly stdout: Writable
    readonly stderr: Writable
    readonly cwd: string
    readonly env: Readonly<Record<string, string | undefined>>
    readonly signal?: AbortSignal
    readonly watchIo?: WatchIo
  },
) => Promise<number>
// The type-test project includes `test/` but not `src/`, so the command is loaded by URL.
const { main } = (await import(new URL('../src/internal/cli.ts', import.meta.url).href)) as {
  main: Main
}

const { USAGE } = (await import(new URL('../src/internal/usage.ts', import.meta.url).href)) as {
  USAGE: string
}

const makeWatchProject = trackedProjects()

/** The stream the reporters write to: what is written, and a way to wait for more of it. */
class Terminal extends Writable {
  text = ''
  readonly isTTY: boolean
  readonly columns = 120
  private readonly waiters = new Set<() => void>()
  constructor(tty: boolean) {
    super()
    this.isTTY = tty
  }
  override _write(chunk: Buffer | string, _encoding: string, done: () => void): void {
    this.text += String(chunk)
    for (const waiter of [...this.waiters]) waiter()
    done()
  }
  /** Resolves once the text holds `count` matches of `pattern`; no clock. */
  waitFor(pattern: RegExp, count: number): Promise<void> {
    const enough = (): boolean => (this.text.match(pattern)?.length ?? 0) >= count
    if (enough()) return Promise.resolve()
    return new Promise((resolve) => {
      const check = (): void => {
        if (!enough()) return
        this.waiters.delete(check)
        resolve()
      }
      this.waiters.add(check)
    })
  }
}

/** A terminal's input in raw mode. */
class Stdin extends EventEmitter {
  isTTY = true
  isRaw = false
  setRawMode(mode: boolean): this {
    this.isRaw = mode
    return this
  }
  resume(): this {
    return this
  }
  pause(): this {
    return this
  }
  setEncoding(): this {
    return this
  }
}

const TOTALS = /^Tests:/gm
const HINT = /^Watching: a runs all, f runs the failed, Enter reruns, q quits$/gm

const FILES: Readonly<Record<string, string>> = {
  'src/a.ts': 'export const a = 1\n',
  'src/b.ts': 'export const b = 1\n',
  'tests/a.test.ts':
    "import { expect, test } from 'provino'\nimport { a } from '../src/a.ts'\ntest('a', () => { expect(a).toBe(1) })\n",
  'tests/b.test.ts':
    "import { expect, test } from 'provino'\nimport { b } from '../src/b.ts'\ntest('b', () => { expect(b).toBe(1) })\n",
}
const CONFIG = "export default { include: ['tests/**/*.test.ts'] }\n"

async function start(
  args: readonly string[],
  options: { readonly tty?: boolean; readonly files?: Readonly<Record<string, string>> } = {},
) {
  const tty = options.tty ?? false
  const project = await makeWatchProject({ ...FILES, ...options.files }, CONFIG)
  const stderr = new Terminal(tty)
  const stdin = new Stdin()
  const controller = new AbortController()
  let sink:
    | { readonly event: (event: { kind: 'change'; path: string; mtimeMs: undefined }) => void }
    | undefined
  const pending: (() => void)[] = []
  const result = main(['run', '--config', project.config, ...args], {
    stdout: new Collect(),
    stderr,
    cwd: project.dir,
    env: { TERM: 'xterm-256color' },
    signal: controller.signal,
    watchIo: {
      stdin,
      changes: (given: NonNullable<typeof sink>) => {
        sink = given
        return { close: () => {} }
      },
      clock: {
        schedule(callback: () => void) {
          pending.push(callback)
          return () => {}
        },
      },
    },
  })
  return {
    project,
    stderr,
    stdin,
    result,
    controller,
    /** A change to `name`, delivered as the coalescing window ends. */
    change(name: string): void {
      assert.ok(sink, 'the session has not started')
      sink.event({ kind: 'change', path: project.path(name), mtimeMs: undefined })
      for (const callback of pending.splice(0)) callback()
    },
    key(text: string): void {
      stdin.emit('data', text)
    },
  }
}

describe('provino run --watch', () => {
  it('runs every file, then only the files a change reaches', async () => {
    const watch = await start(['--watch'])
    await watch.stderr.waitFor(TOTALS, 1)
    assert.match(watch.stderr.text, /tests\/a\.test\.ts/)
    assert.match(watch.stderr.text, /tests\/b\.test\.ts/)
    const first = watch.stderr.text.length
    await writeFile(watch.project.path('src/a.ts'), 'export const a = 1 // edited\n')
    watch.change('src/a.ts')
    await watch.stderr.waitFor(TOTALS, 2)
    const second = watch.stderr.text.slice(first)
    assert.match(second, /tests\/a\.test\.ts/)
    assert.doesNotMatch(second, /tests\/b\.test\.ts/)
    // Off a terminal there are no keys and no hint.
    assert.equal(watch.stdin.listenerCount('data'), 0)
    assert.doesNotMatch(watch.stderr.text, HINT)
    watch.controller.abort()
    assert.equal(await watch.result, 0)
  })

  it('--watchAll reruns every file on any change', async () => {
    const watch = await start(['--watchAll'])
    await watch.stderr.waitFor(TOTALS, 1)
    const first = watch.stderr.text.length
    watch.change('src/a.ts')
    await watch.stderr.waitFor(TOTALS, 2)
    const second = watch.stderr.text.slice(first)
    assert.match(second, /tests\/a\.test\.ts/)
    assert.match(second, /tests\/b\.test\.ts/)
    watch.controller.abort()
    assert.equal(await watch.result, 0)
  })

  it('a change to package.json, which nothing maps, reruns every file', async () => {
    const watch = await start(['--watch'])
    await watch.stderr.waitFor(TOTALS, 1)
    const first = watch.stderr.text.length
    watch.change('package.json')
    await watch.stderr.waitFor(TOTALS, 2)
    const second = watch.stderr.text.slice(first)
    assert.match(second, /tests\/a\.test\.ts/)
    assert.match(second, /tests\/b\.test\.ts/)
    watch.controller.abort()
    assert.equal(await watch.result, 0)
  })

  it('on a terminal a runs all, f the failed, Enter the last, q quits and raw mode is left', async () => {
    const watch = await start(['--watch', '--reporter', 'default'], {
      tty: true,
      files: {
        'tests/b.test.ts':
          "import { expect, test } from 'provino'\ntest('b', () => { expect(1).toBe(2) })\n",
      },
    })
    await watch.stderr.waitFor(HINT, 1)
    assert.equal(watch.stdin.isRaw, true)
    let from = watch.stderr.text.length
    watch.key('f')
    await watch.stderr.waitFor(HINT, 2)
    let segment = watch.stderr.text.slice(from)
    assert.match(segment, /tests\/b\.test\.ts/)
    assert.doesNotMatch(segment, /tests\/a\.test\.ts/)
    from = watch.stderr.text.length
    watch.key('a')
    await watch.stderr.waitFor(HINT, 3)
    segment = watch.stderr.text.slice(from)
    assert.match(segment, /tests\/a\.test\.ts/)
    assert.match(segment, /tests\/b\.test\.ts/)
    from = watch.stderr.text.length
    watch.key('\r')
    await watch.stderr.waitFor(HINT, 4)
    assert.match(watch.stderr.text.slice(from), /tests\/a\.test\.ts/)
    watch.key('q')
    assert.equal(await watch.result, 0)
    assert.equal(watch.stdin.isRaw, false)
    assert.equal(watch.stdin.listenerCount('data'), 0)
  })

  it('f with nothing failed says so and runs nothing', async () => {
    const watch = await start(['--watch'], { tty: true })
    await watch.stderr.waitFor(HINT, 1)
    const from = watch.stderr.text.length
    watch.key('f')
    await watch.stderr.waitFor(/No failed test files to run\./g, 1)
    await watch.stderr.waitFor(HINT, 2)
    assert.doesNotMatch(watch.stderr.text.slice(from), /tests\/a\.test\.ts/)
    watch.key('\x03')
    assert.equal(await watch.result, 0)
  })

  it('a signal ends the session and puts the terminal back', async () => {
    const watch = await start(['--watch'], { tty: true })
    await watch.stderr.waitFor(HINT, 1)
    watch.controller.abort('SIGINT')
    assert.equal(await watch.result, 0)
    assert.equal(watch.stdin.isRaw, false)
    assert.equal(watch.stdin.listenerCount('data'), 0)
  })

  it('refuses --coverage, --shard and --detectOpenHandles by name, before anything runs', async () => {
    const cases: readonly [readonly string[], RegExp][] = [
      [['--watch', '--coverage'], /--coverage in watch mode is not supported yet/],
      [['--watch', '--shard', '1/2'], /--shard in watch mode is not supported/],
      [['--watchAll', '--detectOpenHandles'], /--detectOpenHandles in watch mode is not supported/],
      [['--watch', '--watchAll'], /--watch and --watchAll are one or the other/],
    ]
    for (const [args, message] of cases) {
      const project = await makeProject(FILES, CONFIG)
      const stderr = new Terminal(false)
      const code = await main(['run', '--config', project.config, ...args], {
        stdout: new Collect(),
        stderr,
        cwd: project.dir,
        env: {},
      })
      await project.cleanup()
      assert.equal(code, 2, stderr.text)
      assert.match(stderr.text, message)
      assert.doesNotMatch(stderr.text, TOTALS)
    }
  })

  it('--help documents the flags and the keys', () => {
    assert.match(USAGE, /--watch /)
    assert.match(USAGE, /--watchAll/)
    assert.match(USAGE, /a runs all, f runs the failed, Enter reruns the\s+last, q quits/)
  })
})

/** Resolves once `stream` has written `count` matches of `pattern`; no clock. */
function seen(stream: NodeJS.ReadableStream | null, pattern: RegExp, count: number): Promise<void> {
  let text = ''
  return new Promise((resolve) => {
    stream?.on('data', (chunk: Buffer) => {
      text += chunk.toString()
      if ((text.match(pattern)?.length ?? 0) >= count) resolve()
    })
  })
}

describe('the bin under --watch', async () => {
  const skip = await watcherSkip()
  it('reruns on a real file change, and SIGINT ends it with 130', {
    skip,
    timeout: 120_000,
  }, async () => {
    const project = await makeWatchProject(FILES, CONFIG)
    const cli = startCli(['run', '--config', project.config, '--watch'], {
      cwd: project.dir,
      detached: true,
    })
    const first = seen(cli.child.stderr, TOTALS, 1)
    const second = seen(cli.child.stderr, TOTALS, 2)
    await first
    await writeFile(project.path('src/a.ts'), 'export const a = 1 // edited\n')
    await second
    cli.child.kill('SIGINT')
    const ended = await cli.exited
    assert.equal(ended.code, 130, cli.stderr())
  })
})
