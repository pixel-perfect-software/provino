import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HarnessError } from '../errors.ts'
import type { ScmStep, WatchStep } from '../fixture.ts'
import type { PtyExit, PtyMatch } from '../pty.ts'
import { keyBytes, runWatchSteps, type WatchHost } from './watch-steps.ts'

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
    return this.text.indexOf(match, from) === -1
      ? Promise.reject(new HarnessError('HARNESS_WATCH_FAILED', `no ${match}`))
      : Promise.resolve(this.text.length)
  }

  end(exitCode: number): void {
    this.#end({ exitCode, killed: false })
  }
}

function hostOf(
  session: FakeSession,
  options: { onRuns?: (count: number) => void } = {},
): WatchHost & { readonly runs: number[]; readonly changes: ScmStep[] } {
  const runs: number[] = []
  const changes: ScmStep[] = []
  return {
    session,
    runs,
    changes,
    async waitRuns(count) {
      runs.push(count)
      options.onRuns?.(count)
    },
    async change(step) {
      changes.push(step)
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
  assert.deepEqual(result, { runs: 2 })
})

test('a waitText after a key looks only at what the key drew', async () => {
  const session = new FakeSession((written) => (written === 'w' ? 'Watch Usage' : ''))
  session.text = 'Watch Usage: Press w to show more.'
  await runWatchSteps([{ key: 'w' }, { waitText: 'Watch Usage' }], hostOf(session))
  assert.deepEqual(session.waits, [
    { match: 'Watch Usage', from: 'Watch Usage: Press w to show more.'.length },
  ])
})

test('type writes one character at a time and waits for the text so far after each', async () => {
  let shown = ''
  const session = new FakeSession((written) => {
    shown += written
    return `\u001b[2K pattern › ${shown}`
  })
  await runWatchSteps([{ type: 'foo' }, { key: '<enter>' }], hostOf(session))
  assert.deepEqual(session.writes, ['f', 'o', 'o', '\r'])
  assert.deepEqual(
    session.waits.map((wait) => wait.match),
    ['f', 'fo', 'foo'],
  )
  // Each wait looks only at what came after its own write.
  assert.deepEqual(
    session.waits.map((wait) => wait.from),
    [0, ' pattern › f'.length + 4, (' pattern › f'.length + 4) * 2 + 1],
  )
})

test('a character the terminal never shows fails the step instead of racing ahead', async () => {
  const session = new FakeSession(() => '')
  await assert.rejects(
    runWatchSteps([{ type: 'ab' }], hostOf(session)),
    (error: unknown) => error instanceof HarnessError && error.code === 'HARNESS_WATCH_FAILED',
  )
  assert.deepEqual(session.writes, ['a'])
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
  assert.deepEqual(result, { runs: 0, exit: { exitCode: 0, killed: false } })

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
  }
  await assert.rejects(
    runWatchSteps([{ waitRun: 1 }, { key: 'q' }], host),
    /a run no step waited for/,
  )
  assert.deepEqual(session.writes, [])
})
