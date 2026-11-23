// B26 Phase 3: the `provino` reporter on a real terminal, through the built bin on the harness's
// pty relay. The cursor it hides on the first frame is shown again on every way out: a normal
// end, a reporter that throws, SIGINT (130), SIGTERM (143), SIGHUP (129), SIGQUIT (131) and a second signal (the force path,
// `process.exit`), and no footer is left on the screen (the harness's terminal model). Each run
// is a session of its own (a pty child leads its group), killed and checked gone afterwards.
//
// A sandbox that denies `/dev/ptmx` can't open a terminal: the tests skip there, saying so, and
// with `CI` set they refuse to skip (CI's Linux legs run them). They need `pnpm --filter provino
// build` (turbo's `test` builds first).
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { describe, it } from 'node:test'
import { isCi } from '@provino/reporters'
import { BUILT_BIN, interactiveEnv, jestConfigJson, passing, trackedProjects } from './support.ts'

/** The harness's terminal pieces, loaded by path: `provino` may not import `@provino/harness`. */
const HARNESS = new URL('../../harness/src/', import.meta.url)

interface PtyProcess {
  readonly output: () => string
  waitFor(match: string | ((output: string) => number), from?: number): Promise<number>
  readonly exit: Promise<{ readonly exitCode: number | null; readonly killed: boolean }>
  readonly childPgid: number
  kill(): Promise<void>
}

const pty = (await import(new URL('pty.ts', HARNESS).href)) as {
  spawnPty(
    argv: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; deadline?: AbortSignal },
  ): Promise<PtyProcess>
  groupExists(pgid: number): boolean
}
const transcript = (await import(new URL('internal/watch-transcript.ts', HARNESS).href)) as {
  renderTranscript(output: string): string
}

const ESC = String.fromCharCode(27)
const HIDE = `${ESC}[?25l`
const SHOW = `${ESC}[?25h`

/** Why the terminal runs can't be done here, or `false`. With `CI` set a reason is an error. */
async function terminalSkip(): Promise<string | false> {
  let reason: string | undefined
  if (!existsSync(BUILT_BIN)) reason = `no build at ${BUILT_BIN}: run pnpm --filter provino build`
  else {
    try {
      const probe = await pty.spawnPty(['/bin/echo', 'ready'], {
        cwd: process.cwd(),
        env: process.env,
      })
      await probe.exit
      await probe.kill()
    } catch (error) {
      reason = `no terminal: ${(error as Error).message.split('\n')[0]}`
    }
  }
  if (reason === undefined) return false
  if (isCi(process.env)) throw new Error(`${reason}, and in CI the terminal tests must run`)
  return `${reason} (a sandbox): CI runs these`
}

/**
 * `terminalSkip`, probed once by the first test that asks (a probe at import would run on every
 * listing of this file). Where the sandbox has no terminal, it says so in the output, not only in
 * the skip.
 */
let probed: Promise<string | false> | undefined
function skipHere(): Promise<string | false> {
  probed ??= terminalSkip().then((reason) => {
    if (reason !== false) process.stderr.write(`provino-reporter-terminal: skipped: ${reason}\n`)
    return reason
  })
  return probed
}
const makeProject = trackedProjects()

/** An interactive terminal: nothing that says CI, an agent or a colour choice. */
function terminalEnv(): NodeJS.ProcessEnv {
  // None of a CI runner's variables: under `CI` the run would not be live (D135).
  const env: NodeJS.ProcessEnv = { ...interactiveEnv(), TERM: 'xterm-256color' }
  for (const name of ['TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'COLORTERM']) delete env[name]
  return env
}

/** A test file that loops without yielding for 120 s: bounded, so a worker left behind ends. */
const HANGING =
  "test('hangs', () => { const end = Date.now() + 120_000; while (Date.now() < end) {} })\n"

/** The built bin with `args` on a terminal, in `cwd`, under a 60 s deadline. */
async function onTerminal(args: readonly string[], cwd: string): Promise<PtyProcess> {
  return pty.spawnPty([process.execPath, BUILT_BIN, ...args], {
    cwd,
    env: terminalEnv(),
    deadline: AbortSignal.timeout(60_000),
  })
}

/** Kills the session's group and holds that nothing of it is left. */
async function ended(session: PtyProcess): Promise<void> {
  await session.kill()
  assert.equal(pty.groupExists(session.childPgid), false, `group ${session.childPgid} is left`)
}

/** The cursor was hidden by a frame and is shown again at the end, and no footer row is left. */
function assertRestored(output: string): void {
  const hidden = output.indexOf(HIDE)
  assert.ok(hidden !== -1, `no frame hid the cursor:\n${JSON.stringify(output)}`)
  assert.ok(output.lastIndexOf(SHOW) > output.lastIndexOf(HIDE), 'the cursor is left hidden')
  const screen = transcript.renderTranscript(output)
  assert.doesNotMatch(screen, / of \d+ files? /, `a status line is left:\n${screen}`)
}

describe('the provino reporter restores the terminal (B26 Phase 3)', () => {
  it('a normal end: hidden once before the first footer, shown once after the end card', async (t) => {
    const skip = await skipHere()
    if (skip !== false) return t.skip(skip)
    const project = await makeProject({
      'tests/a.test.js': passing('a'),
      'tests/b.test.js': passing('b'),
    })
    const session = await onTerminal(['run', '--config', project.config], project.dir)
    try {
      const exit = await session.exit
      assert.equal(exit.exitCode, 0, session.output())
      const output = session.output()
      assertRestored(output)
      assert.equal(output.split(HIDE).length - 1, 1, 'hidden once')
      assert.equal(output.split(SHOW).length - 1, 1, 'shown once')
      assert.ok(output.indexOf('2 tests passed in 2 files') < output.lastIndexOf(SHOW))
    } finally {
      await ended(session)
    }
  })

  it('a reporter that throws: exit 1, its error above the footer, the cursor shown', async (t) => {
    const skip = await skipHere()
    if (skip !== false) return t.skip(skip)
    const project = await makeProject({
      'tests/a.test.js': passing('a'),
      'tests/b.test.js': passing('b'),
      'throws.js':
        "module.exports = class { onTestResult() { throw new Error('the reporter broke') } }\n",
    })
    const config = jestConfigJson(project.dir, { reporters: ['provino', '<rootDir>/throws.js'] })
    const session = await onTerminal(['jest', `--config=${config}`], project.dir)
    try {
      const exit = await session.exit
      assert.equal(exit.exitCode, 1, session.output())
      const output = session.output()
      assertRestored(output)
      assert.match(transcript.renderTranscript(output), /the reporter broke/)
    } finally {
      await ended(session)
    }
  })

  // SIGINT, SIGTERM and SIGHUP are the bin's (the run ends, and its end restores the terminal);
  // SIGQUIT is no one's, so the live region's own handler restores it and raises it again: the
  // default action ends the process, 128 + 3.
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
    ['SIGQUIT', 131],
  ] as const) {
    it(`${signal} mid-run: exit ${code}, the cursor shown, no footer left`, async (t) => {
      const skip = await skipHere()
      if (skip !== false) return t.skip(skip)
      const project = await makeProject({
        'tests/hang.test.js': HANGING,
        'tests/hang2.test.js': HANGING,
      })
      const session = await onTerminal(
        ['run', '--config', project.config, '--maxWorkers', '2'],
        project.dir,
      )
      try {
        await session.waitFor('hang')
        process.kill(-session.childPgid, signal)
        const exit = await session.exit
        assert.equal(exit.exitCode, code, session.output())
        assertRestored(session.output())
      } finally {
        await ended(session)
      }
    })
  }

  it('a second signal within 1 s (the force path, process.exit): the cursor is still shown', async (t) => {
    const skip = await skipHere()
    if (skip !== false) return t.skip(skip)
    const project = await makeProject({
      'tests/hang.test.js': HANGING,
      'tests/hang2.test.js': HANGING,
    })
    const session = await onTerminal(
      ['run', '--config', project.config, '--maxWorkers', '2'],
      project.dir,
    )
    try {
      await session.waitFor('hang')
      process.kill(-session.childPgid, 'SIGTERM')
      process.kill(-session.childPgid, 'SIGTERM')
      const exit = await session.exit
      assert.equal(exit.exitCode, 143, session.output())
      assertRestored(session.output())
    } finally {
      await ended(session)
    }
  })
})
