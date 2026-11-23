import assert from 'node:assert/strict'
import { test } from 'provino'
import { HarnessError } from '../errors.ts'
import type { ScmStep, WatchStep } from '../fixture.ts'
import type { PtyExit, PtyMatch } from '../pty.ts'
import {
  keyBytes,
  PATTERN_CARET,
  RESULTS_WRITTEN,
  runWatchSteps,
  type WatchHost,
} from './watch-steps.ts'

/**
 * A terminal that answers each write from a script, at once: no process and no clock. `respond`
 * gets each write and returns what the "child" prints for it.
 */
class FakeSession {
  text = ''
  readonly writes: string[] = []
  readonly waits: { match: string; from: number }[] = []
  readonly exit: Promise<PtyExit>
  #end: (exit: PtyExit) => void = () => {}
  readonly respond: (written: string, session: FakeSession) => string

  constructor(respond: (written: string, session: FakeSession) => string = () => '') {
    this.respond = respond
    this.exit = new Promise((resolve) => {
      this.#end = resolve
    })
  }

  write(text: string): void {
    this.writes.push(text)
    this.text += this.respond(text, this)
  }

  readonly output = (): string => this.text

  waitFor(match: PtyMatch, from = 0): Promise<number> {
    if (typeof match !== 'string') throw new Error('the steps wait for text')
    this.waits.push({ match, from })
    // As the real watch does: the index just past the match.
    const at = this.text.indexOf(match, from)
    return at === -1
      ? Promise.reject(new HarnessError('HARNESS_WATCH_FAILED', `no ${match}`))
      : Promise.resolve(at + match.length)
  }

  end(exitCode: number): void {
    this.#end({ exitCode, killed: false })
  }
}

function hostOf(
  session: FakeSession,
  options: { onRuns?: (count: number) => void } = {},
): WatchHost & {
  readonly runs: number[]
  readonly changes: ScmStep[]
  readonly captured: string[]
} {
  const captured: string[] = []
  const runs: number[] = []
  const changes: ScmStep[] = []
  return {
    session,
    runs,
    changes,
    captured,
    async waitRuns(count) {
      runs.push(count)
      options.onRuns?.(count)
    },
    async change(step) {
      changes.push(step)
    },
    async captureFile(_file, key) {
      captured.push(key)
      return { key }
    },
  }
}

test('keys are sent as the bytes a terminal sends', () => {
  assert.equal(keyBytes('<enter>'), '\r')
  assert.equal(keyBytes('<esc>'), '\u001b')
  assert.equal(keyBytes('<ctrl-c>'), '\u0003')
  assert.equal(keyBytes('<up>'), '\u001b[A')
  assert.equal(keyBytes('p'), 'p')
})

test('a run is waited for through the host, and a key after it is sent once it has ended', async () => {
  const events: string[] = []
  const session = new FakeSession((written) => {
    events.push(`key ${written}`)
    return ''
  })
  const host = hostOf(session, { onRuns: (count) => events.push(`run ${count}`) })
  const result = await runWatchSteps([{ waitRun: 1 }, { key: 'a' }, { waitRun: 2 }], host)
  assert.deepEqual(events, ['run 1', 'key a', 'run 2'])
  assert.deepEqual(result, { runs: 2, captures: {} })
})

test('a waitText after a key looks only at what the key drew', async () => {
  const session = new FakeSession((written) => (written === 'w' ? 'Watch Usage' : ''))
  session.text = 'Watch Usage: Press w to show more.'
  await runWatchSteps([{ key: 'w' }, { waitText: 'Watch Usage' }], hostOf(session))
  assert.deepEqual(session.waits, [
    { match: 'Watch Usage', from: 'Watch Usage: Press w to show more.'.length },
  ])
})

test('type writes one character at a time and waits for the prompt line of the text so far', async () => {
  let shown = ''
  const session = new FakeSession((written) => {
    shown += written
    return `\u001b[2K pattern › ${shown}`
  })
  await runWatchSteps([{ type: 'foo' }, { key: '<enter>' }], hostOf(session))
  assert.deepEqual(session.writes, ['f', 'o', 'o', '\r'])
  assert.deepEqual(
    session.waits.map((wait) => wait.match),
    [' pattern › f', ' pattern › fo', ' pattern › foo'],
  )
  // Each wait looks only at what came after its own write.
  assert.deepEqual(
    session.waits.map((wait) => wait.from),
    [0, ' pattern › f'.length + 4, (' pattern › f'.length + 4) * 2 + 1],
  )
})

test('the caret is the one jest-watcher draws, colour off', () => {
  assert.equal(PATTERN_CARET, ' pattern \u203a ')
})

test('a match list that holds the text is not the echo: the next key waits for the prompt line', async () => {
  // watch/plugin-typeahead-filename, 2026-11-14: `f` drew its prompt line, and the list under it
  // (` › ./foo.test.ts`) was still arriving when `o` was written. The list holds `fo` and `foo`,
  // so both `o`s and the Enter went out before Jest read the first `o`, and Jest read `o\r` as
  // one key: the pattern became `foo\r`, matched no file, and run 2 never started.
  const shown: string[] = []
  const session = new FakeSession((written) => {
    shown.push(written)
    // `f` is handled at once; what comes back for the first `o` is the rest of `f`'s screen.
    if (shown.length === 1) return `\u001b[J pattern › f\u001b[s\r\n\r\n Pattern matches 2 files`
    if (shown.length === 2) return '\r\n › ./bar.test.ts\r\n › ./foo.test.ts'
    return ''
  })
  await assert.rejects(
    runWatchSteps([{ type: 'foo' }, { key: '<enter>' }], hostOf(session)),
    (error: unknown) => error instanceof HarnessError && error.code === 'HARNESS_WATCH_FAILED',
  )
  // Nothing after the first `o` until the prompt shows `fo`: the second `o` and the Enter wait.
  assert.deepEqual(session.writes, ['f', 'o'])
})

test('a character the terminal never shows fails the step instead of racing ahead', async () => {
  const session = new FakeSession(() => '')
  await assert.rejects(
    runWatchSteps([{ type: 'ab' }], hostOf(session)),
    (error: unknown) => error instanceof HarnessError && error.code === 'HARNESS_WATCH_FAILED',
  )
  assert.deepEqual(session.writes, ['a'])
})

test('a type step that never sees its prompt line says so, and that type needs a pattern prompt', async () => {
  const session = new FakeSession()
  await assert.rejects(
    runWatchSteps([{ type: 'ab' }], hostOf(session)),
    (error: unknown) =>
      error instanceof HarnessError &&
      error.code === 'HARNESS_WATCH_FAILED' &&
      error.message.includes('the prompt never drew " pattern \u203a a"') &&
      error.message.includes('"type" works only in a pattern prompt'),
  )
})

test('waitText waits after the last match, and changes go to the host in order', async () => {
  const session = new FakeSession((written) => (written === 'p' ? 'Pattern Mode Usage' : ''))
  const host = hostOf(session)
  const steps: WatchStep[] = [
    { key: 'p' },
    { waitText: 'Pattern Mode Usage' },
    { write: { 'a.ts': 'x' } },
    { remove: ['b.ts'] },
    { scm: [{ commit: 'one' }, { branch: 'two' }] },
  ]
  await runWatchSteps(steps, host)
  assert.deepEqual(host.changes, [
    { write: { 'a.ts': 'x' } },
    { remove: ['b.ts'] },
    { commit: 'one' },
    { branch: 'two' },
  ])
  // The text came before the wait started, after the key: a later wait for it starts past it.
  await assert.rejects(
    runWatchSteps([{ waitText: 'Pattern Mode Usage' }, { waitText: 'Pattern Mode Usage' }], host),
    HarnessError,
  )
})

test('exit waits for the session and checks its code', async () => {
  const session = new FakeSession((written) => {
    if (written === 'q') queueMicrotask(() => session.end(0))
    return ''
  })
  const result = await runWatchSteps([{ key: 'q' }, { exit: 0 }], hostOf(session))
  assert.deepEqual(result, {
    runs: 0,
    exit: { exitCode: 0, killed: false },
    captures: {},
  })

  const other = new FakeSession()
  other.end(1)
  await assert.rejects(
    runWatchSteps([{ exit: 0 }], hostOf(other)),
    (error: unknown) =>
      error instanceof HarnessError &&
      error.code === 'HARNESS_WATCH_FAILED' &&
      error.message.includes('exit code 1'),
  )
})

test('a run log that fails its wait fails the steps there', async () => {
  const session = new FakeSession()
  const host: WatchHost = {
    session,
    waitRuns: () =>
      Promise.reject(new HarnessError('HARNESS_WATCH_FAILED', 'a run no step waited for')),
    change: async () => {},
    captureFile: async () => null,
  }
  await assert.rejects(
    runWatchSteps([{ waitRun: 1 }, { key: 'q' }], host),
    /a run no step waited for/,
  )
  assert.deepEqual(session.writes, [])
})

test('two waitTexts that one read answers both pass: each starts where the last match ended', async () => {
  const session = new FakeSession((written) =>
    written === 'p' ? '\nPattern Mode Usage\n › Press Esc to exit pattern mode.\n' : '',
  )
  await runWatchSteps(
    [{ key: 'p' }, { waitText: 'Pattern Mode Usage' }, { waitText: 'to exit pattern mode.' }],
    hostOf(session),
  )
  assert.deepEqual(
    session.waits.map((wait) => wait.from),
    [0, '\nPattern Mode Usage'.length],
  )
})

test('a character waits for the prompt line, and goes out once it arrives', async () => {
  // As the test above, but the wait really waits: the list is drawn first, the line after it.
  class SlowSession extends FakeSession {
    readonly pending: { match: string; from: number; resolve: (end: number) => void }[] = []
    override waitFor(match: PtyMatch, from = 0): Promise<number> {
      if (typeof match !== 'string') throw new Error('the steps wait for text')
      this.waits.push({ match, from })
      return new Promise((resolve) => {
        this.pending.push({ match, from, resolve })
        this.settle()
      })
    }
    arrive(text: string): void {
      this.text += text
      this.settle()
    }
    settle(): void {
      for (const wait of [...this.pending]) {
        const at = this.text.indexOf(wait.match, wait.from)
        if (at === -1) continue
        this.pending.splice(this.pending.indexOf(wait), 1)
        wait.resolve(at + wait.match.length)
      }
    }
  }
  const session = new SlowSession()
  const done = runWatchSteps([{ type: 'fo' }, { key: '<enter>' }], hostOf(session))
  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
  await tick()
  assert.deepEqual(session.writes, ['f'])
  session.arrive('\u001b[J pattern › f')
  await tick()
  assert.deepEqual(session.writes, ['f', 'o'])
  // The list holding `fo` is no echo: the Enter still waits.
  session.arrive('\r\n › ./foo.test.ts')
  await tick()
  assert.deepEqual(session.writes, ['f', 'o'])
  session.arrive('\u001b[J pattern › fo')
  await tick()
  assert.deepEqual(session.writes, ['f', 'o', '\r'])
  await done
  assert.deepEqual(session.writes, ['f', 'o', '\r'])
})

test('a captureFile step reads its file once Jest says it wrote one: the n-th line for the n-th capture', async () => {
  const session = new FakeSession()
  // Each run ends with Jest writing its results file and saying so.
  const host = hostOf(session, {
    onRuns: () => {
      session.text += `${RESULTS_WRITTEN}: out.json\r\n`
    },
  })
  const result = await runWatchSteps(
    [{ waitRun: 1 }, { captureFile: 'out.json' }, { waitRun: 2 }, { captureFile: 'out.json' }],
    host,
  )
  // Keyed `<file>#<n>`, in the order the steps asked, as the host returned them.
  assert.deepEqual(result.captures, {
    'out.json#1': { key: 'out.json#1' },
    'out.json#2': { key: 'out.json#2' },
  })
  assert.deepEqual(host.captured, ['out.json#1', 'out.json#2'])
  assert.deepEqual(host.runs, [1, 2])
  // Each wait starts past the line the capture before consumed.
  const line = `${RESULTS_WRITTEN}: out.json\r\n`
  assert.deepEqual(session.waits, [
    { match: RESULTS_WRITTEN, from: 0 },
    { match: RESULTS_WRITTEN, from: RESULTS_WRITTEN.length },
  ])
  assert.equal(session.text, line + line)
})

test('a capture never reads before its own line: run 1\u2019s file is not run 2\u2019s', async () => {
  // One line is shown, two captures are asked for: the second never sees a line of its own.
  const session = new FakeSession()
  session.text = `${RESULTS_WRITTEN}: out.json\r\n`
  const host = hostOf(session)
  await assert.rejects(
    runWatchSteps([{ captureFile: 'out.json' }, { captureFile: 'out.json' }], host),
    (error: unknown) =>
      error instanceof HarnessError &&
      /never wrote its results file for capture out\.json#2/.test(error.message) &&
      /no Test results written to/.test(error.message),
  )
  assert.deepEqual(host.captured, ['out.json#1'])
})

test('captures are counted per file', async () => {
  const session = new FakeSession()
  session.text = `${RESULTS_WRITTEN}: a.json\r\n${RESULTS_WRITTEN}: b.json\r\n${RESULTS_WRITTEN}: a.json\r\n`
  const host = hostOf(session)
  const result = await runWatchSteps(
    [{ captureFile: 'a.json' }, { captureFile: 'b.json' }, { captureFile: 'a.json' }],
    host,
  )
  assert.deepEqual(Object.keys(result.captures), ['a.json#1', 'b.json#1', 'a.json#2'])
})
