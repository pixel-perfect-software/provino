// `provino run --watch` and `--watchAll` on a native project (B27k, D202), in this process: the
// command on a fake terminal (one stream for stderr with `isTTY`, a stdin with raw mode), the
// changes fed to the session and its coalescing clock fired by hand, so nothing here waits on time.
// A test waits for the run's own totals line to be written, not for a delay.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import type { Writable } from 'node:stream'
import { describe, it } from 'provino'
import { Collect, makeProject, startCli, trackedProjects } from './support.ts'
import { FakeStdin, FakeTerminal, skipped } from './watch-goldens.ts'

interface WatchIo {
  readonly stdin?: unknown
  readonly changes?: unknown
  readonly clock?: unknown
  readonly suspend?: () => void
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
const { COVERAGE_NOTICE, WATCH_HINT } = (await import(
  new URL('../src/internal/native-watch.ts', import.meta.url).href
)) as { COVERAGE_NOTICE: string; WATCH_HINT: string }

const makeWatchProject = trackedProjects()

/** A terminal's input: a tty that raw mode can be set on. */
class TtyStdin extends FakeStdin {
  isTTY = true
}

const TOTALS = /^Tests:/gm
const HINT = new RegExp(`^${WATCH_HINT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'gm')

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
  options: {
    readonly tty?: boolean
    readonly files?: Readonly<Record<string, string>>
    readonly config?: string
    readonly stdin?: FakeStdin
    readonly aborted?: boolean
    readonly suspend?: () => void
  } = {},
) {
  const tty = options.tty ?? false
  const project = await makeWatchProject({ ...FILES, ...options.files }, options.config ?? CONFIG)
  const stderr = new FakeTerminal(tty)
  const stdin = options.stdin ?? (tty ? new TtyStdin() : new FakeStdin())
  const controller = new AbortController()
  if (options.aborted === true) controller.abort('SIGINT')
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
      ...(options.suspend === undefined ? {} : { suspend: options.suspend }),
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

describe('provino run --watch with test path patterns', () => {
  it('keeps every run, a related one included, inside the patterns (B28)', async () => {
    const watch = await start(['--watch', 'tests/a'])
    await watch.stderr.waitFor(TOTALS, 1)
    assert.match(watch.stderr.text, /tests\/a\.test\.ts/)
    assert.doesNotMatch(watch.stderr.text, /tests\/b\.test\.ts/)
    // A change that reaches only the file the patterns leave out runs nothing.
    let from = watch.stderr.text.length
    await writeFile(watch.project.path('src/b.ts'), 'export const b = 1 // edited\n')
    watch.change('src/b.ts')
    await watch.stderr.waitFor(TOTALS, 2)
    assert.doesNotMatch(watch.stderr.text.slice(from), /tests\/b\.test\.ts/)
    // A change that reaches the file inside them runs it, and a project input still only that one.
    from = watch.stderr.text.length
    await writeFile(watch.project.path('src/a.ts'), 'export const a = 1 // edited\n')
    watch.change('src/a.ts')
    await watch.stderr.waitFor(TOTALS, 3)
    assert.match(watch.stderr.text.slice(from), /tests\/a\.test\.ts/)
    from = watch.stderr.text.length
    watch.change('package.json')
    await watch.stderr.waitFor(TOTALS, 4)
    const segment = watch.stderr.text.slice(from)
    assert.match(segment, /tests\/a\.test\.ts/)
    assert.doesNotMatch(segment, /tests\/b\.test\.ts/)
    watch.controller.abort('SIGINT')
    await watch.result
  })
})

describe('provino run --watch', () => {
  it('runs every file, then the files a change reaches, and every file for a project input', async () => {
    const watch = await start(['--watch'])
    await watch.stderr.waitFor(TOTALS, 1)
    assert.match(watch.stderr.text, /tests\/a\.test\.ts/)
    assert.match(watch.stderr.text, /tests\/b\.test\.ts/)
    let from = watch.stderr.text.length
    await writeFile(watch.project.path('src/a.ts'), 'export const a = 1 // edited\n')
    watch.change('src/a.ts')
    await watch.stderr.waitFor(TOTALS, 2)
    let segment = watch.stderr.text.slice(from)
    assert.match(segment, /tests\/a\.test\.ts/)
    assert.doesNotMatch(segment, /tests\/b\.test\.ts/)
    // The root package.json is an input of the project: the index selects every file for it.
    from = watch.stderr.text.length
    watch.change('package.json')
    await watch.stderr.waitFor(TOTALS, 3)
    segment = watch.stderr.text.slice(from)
    assert.match(segment, /tests\/a\.test\.ts/)
    assert.match(segment, /tests\/b\.test\.ts/)
    // Off a terminal there are no keys and no hint.
    assert.equal(watch.stdin.listenerCount('data'), 0)
    assert.doesNotMatch(watch.stderr.text, HINT)
    watch.controller.abort()
    assert.equal(await watch.result, 0)
  })

  it('says once, at the start, that the patterns select no file', async () => {
    const watch = await start(['--watch', 'nothing-like-this'])
    await watch.stderr.waitFor(/no test file matches the pattern "nothing-like-this"/g, 1)
    watch.change('src/a.ts')
    await watch.stderr.waitFor(TOTALS, 1)
    watch.controller.abort()
    await watch.result
    assert.equal(watch.stderr.text.split('no test file matches').length - 1, 1)
  })

  it('a config that enables coverage runs without it and says so once', async () => {
    const watch = await start(['--watch'], {
      config:
        "export default { include: ['tests/**/*.test.ts'], coverage: { enabled: true, directory: 'cov' } }\n",
    })
    await watch.stderr.waitFor(TOTALS, 1)
    assert.equal(watch.stderr.text.split(COVERAGE_NOTICE).length - 1, 1)
    assert.equal(existsSync(watch.project.path('cov')), false)
    watch.change('src/a.ts')
    await watch.stderr.waitFor(TOTALS, 2)
    assert.equal(watch.stderr.text.split(COVERAGE_NOTICE).length - 1, 1)
    watch.controller.abort()
    assert.equal(await watch.result, 0)
  })

  it('--watchAll reruns every file on any change', async () => {
    const watch = await start(['--watchAll'])
    await watch.stderr.waitFor(TOTALS, 1)
    const from = watch.stderr.text.length
    watch.change('src/a.ts')
    await watch.stderr.waitFor(TOTALS, 2)
    const segment = watch.stderr.text.slice(from)
    assert.match(segment, /tests\/a\.test\.ts/)
    assert.match(segment, /tests\/b\.test\.ts/)
    watch.controller.abort()
    assert.equal(await watch.result, 0)
  })

  it('a change to a setup file, a project input, reruns every file', async () => {
    const watch = await start(['--watch'], {
      config: "export default { include: ['tests/**/*.test.ts'], setupFiles: ['./setup.ts'] }\n",
      files: { 'setup.ts': 'export {}\n' },
    })
    await watch.stderr.waitFor(TOTALS, 1)
    const from = watch.stderr.text.length
    watch.change('setup.ts')
    await watch.stderr.waitFor(TOTALS, 2)
    const segment = watch.stderr.text.slice(from)
    assert.match(segment, /tests\/a\.test\.ts/)
    assert.match(segment, /tests\/b\.test\.ts/)
    watch.controller.abort()
    assert.equal(await watch.result, 0)
  })

  it('a change to the config loads it again, says so, and runs every file under the new one', async () => {
    const watch = await start(['--watch'])
    await watch.stderr.waitFor(TOTALS, 1)
    const from = watch.stderr.text.length
    await writeFile(
      watch.project.path('provino.config.mjs'),
      "export default { include: ['tests/a.test.ts'] }\n",
    )
    watch.change('provino.config.mjs')
    await watch.stderr.waitFor(TOTALS, 2)
    const segment = watch.stderr.text.slice(from)
    assert.match(segment, /provino\.config\.mjs changed, loading it again/)
    assert.match(segment, /tests\/a\.test\.ts/)
    assert.doesNotMatch(segment, /tests\/b\.test\.ts/)
    watch.controller.abort()
    assert.equal(await watch.result, 0)
  })

  it('a config that no longer loads is said, and the previous one keeps running', async () => {
    const watch = await start(['--watch'])
    await watch.stderr.waitFor(TOTALS, 1)
    await writeFile(watch.project.path('provino.config.mjs'), 'export default { include: 5 }\n')
    watch.change('provino.config.mjs')
    await watch.stderr.waitFor(/keeping the previous config/g, 1)
    const from = watch.stderr.text.length
    watch.change('src/a.ts')
    await watch.stderr.waitFor(TOTALS, 2)
    assert.match(watch.stderr.text.slice(from), /tests\/a\.test\.ts/)
    watch.controller.abort()
    assert.equal(await watch.result, 0)
  })

  it("on a terminal a runs all, f the failed, Enter the last, q quits with the last run's code", async () => {
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
    // The last run failed, so the command does.
    assert.equal(await watch.result, 1)
    assert.equal(watch.stdin.isRaw, false)
    assert.equal(watch.stdin.listenerCount('data'), 0)
  })

  it('f with nothing failed says so and runs nothing; Ctrl+C quits with 0', async () => {
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

  it('only a single key is a key: Alt+q and a paste do nothing', async () => {
    const watch = await start(['--watch'], { tty: true })
    await watch.stderr.waitFor(HINT, 1)
    watch.key('\x1bq')
    watch.key('qq')
    watch.key('a')
    // The session is still there to answer a real key.
    await watch.stderr.waitFor(HINT, 2)
    watch.key('q')
    assert.equal(await watch.result, 0)
  })

  it('Ctrl+Z puts the terminal back before it suspends, and takes it again on SIGCONT', async () => {
    const seen: boolean[] = []
    const stdin = new TtyStdin()
    const watch = await start(['--watch'], {
      tty: true,
      stdin,
      suspend: () => {
        seen.push(stdin.isRaw)
      },
    })
    await watch.stderr.waitFor(HINT, 1)
    watch.key('\x1a')
    assert.deepEqual(seen, [false])
    process.emit('SIGCONT')
    assert.equal(stdin.isRaw, true)
    watch.key('q')
    assert.equal(await watch.result, 0)
    assert.equal(stdin.isRaw, false)
  })

  it('the end of the input quits', async () => {
    const watch = await start(['--watch'], { tty: true })
    await watch.stderr.waitFor(HINT, 1)
    watch.stdin.emit('end')
    assert.equal(await watch.result, 0)
    assert.equal(watch.stdin.isRaw, false)
  })

  it('a terminal that cannot go raw closes the session and ends the command', async () => {
    class GoneStdin extends TtyStdin {
      override setRawMode(): never {
        throw new Error('the terminal is gone')
      }
    }
    const watch = await start(['--watch'], { tty: true, stdin: new GoneStdin() })
    // The command ends, with the error said and no pool left holding the process.
    assert.equal(await watch.result, 1)
    assert.match(watch.stderr.text, /the terminal is gone/)
  })

  it('raw mode is put back as it was found', async () => {
    const stdin = new TtyStdin()
    stdin.isRaw = true
    const watch = await start(['--watch'], { tty: true, stdin })
    await watch.stderr.waitFor(HINT, 1)
    watch.key('q')
    await watch.result
    assert.equal(stdin.isRaw, true)
  })

  it('a signal that came before the session starts runs nothing', async () => {
    const watch = await start(['--watch'], { aborted: true })
    assert.equal(await watch.result, 0)
    assert.doesNotMatch(watch.stderr.text, TOTALS)
  })

  it('a signal ends the session and puts the terminal back', async () => {
    const watch = await start(['--watch'], { tty: true })
    await watch.stderr.waitFor(HINT, 1)
    watch.controller.abort('SIGINT')
    assert.equal(await watch.result, 0)
    assert.equal(watch.stdin.isRaw, false)
    assert.equal(watch.stdin.listenerCount('data'), 0)
  })

  it('refuses what watch cannot honour, each by name, before anything runs', async () => {
    const project = await makeProject(FILES, CONFIG)
    const cases: readonly [readonly string[], RegExp][] = [
      [['--watch', '--coverage'], /--coverage in watch mode is not supported yet/],
      [['--watch', '--shard', '1/2'], /--shard in watch mode is not supported/],
      [['--watchAll', '--detectOpenHandles'], /--detectOpenHandles in watch mode is not supported/],
      [['--watch', '--timings', 't.json'], /--timings in watch mode is not supported/],
      [['--watch', '--update-timings'], /--update-timings in watch mode is not supported/],
      [['--watch', '--forceExit'], /--forceExit in watch mode is not supported/],
      [['--watch', '--shard', '1/2', '--forceExit'], /--shard, --forceExit in watch mode are not/],
      [['--watch', '--watchAll'], /--watch and --watchAll are one or the other/],
    ]
    try {
      for (const [args, message] of cases) {
        const stderr = new FakeTerminal(false)
        const code = await main(['run', '--config', project.config, ...args], {
          stdout: new Collect(),
          stderr,
          cwd: project.dir,
          env: {},
        })
        assert.equal(code, 2, stderr.text)
        assert.match(stderr.text, message)
        assert.doesNotMatch(stderr.text, TOTALS)
      }
    } finally {
      await project.cleanup()
    }
  })

  it('--help documents the flags and the keys', () => {
    assert.match(USAGE, /--watch /)
    assert.match(USAGE, /--watchAll/)
    assert.match(USAGE, /a runs all, f runs the failed, Enter reruns the\s+last, q quits/)
    // The flags watch refuses are the ones `parseRunArgs` refuses, all of them.
    assert.match(
      USAGE,
      /Not with --coverage, --shard,\s+--detectOpenHandles, --timings, --update-timings or\s+--forceExit/,
    )
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

describe('the bin under --watch', () => {
  it('reruns on a real file change, and SIGINT ends it with 130', {
    timeout: 120_000,
  }, async (t) => {
    if (await skipped(t, false)) return
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
