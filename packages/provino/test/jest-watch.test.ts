// `provino jest --watch` and `--watchAll` (B23c Phase 8, T9.11) against the `watch/*` goldens
// recorded from Jest 30.5.2, played by `watch-goldens.ts` in this process and on a terminal. The
// plugin, `u` and `i` goldens are `jest-watch-plugins.test.ts`'s.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { loadFixture } from './recorded.ts'
import { failing, jestConfigJson, makeProject, passing } from './support.ts'
import {
  FakeStdin,
  FakeTerminal,
  playInProcess,
  playOnTerminal,
  prepare,
  runJestCommand,
  SESSION_MS,
  terminalSkip,
} from './watch-goldens.ts'

/** The goldens this file holds `provino jest` to (the plugin, `u` and `i` ones are `jest-watch-plugins.test.ts`'s). */
const TERMINAL_IDS = [
  'usage-watch',
  'usage-watch-all',
  'key-a',
  'key-f',
  'key-o',
  'key-p',
  'key-t',
  'key-esc',
  'key-enter',
  'key-w',
  'key-q',
  'key-ctrl-c',
  'key-ctrl-d',
  'key-during-run',
  'change-watch',
  'change-watch-all',
  'offline-restart',
]

/** Starts `provino jest --watch` on a fake terminal with the signal already aborted. */
async function abortedAtStart(stdin: FakeStdin): Promise<{
  readonly result: Promise<number>
  readonly terminal: FakeTerminal
  readonly closed: () => boolean
  readonly dispose: () => Promise<void>
}> {
  const { manifest, project, root, configFile } = await prepare(
    await loadFixture('watch/usage-watch-all'),
  )
  const terminal = new FakeTerminal(true)
  let closed = false
  const controller = new AbortController()
  const result = runJestCommand(['--config', configFile, ...manifest.watch.argv], {
    stdout: terminal,
    stderr: terminal,
    cwd: root,
    env: { TERM: 'xterm-256color', NO_COLOR: '1' },
    stdin,
    signal: controller.signal,
    watchChanges: () => ({
      close: () => {
        closed = true
      },
    }),
  })
  // The first run is in flight (the driver starts it as the command starts), then the signal lands.
  controller.abort()
  return { result, terminal, closed: () => closed, dispose: () => project.dispose() }
}

describe('provino jest --watch shutdown (a fake terminal, no waits)', () => {
  it('a signal with a run in flight ends with 0 and prints no error from the closed session', async () => {
    const run = await abortedAtStart(new FakeStdin())
    try {
      assert.equal(await run.result, 0)
      assert.equal(run.closed(), true, 'the session is closed')
      assert.doesNotMatch(run.terminal.text, /watch session is closed|Error/)
    } finally {
      await run.dispose()
    }
  })

  it('raw mode that cannot be left still closes the session', async () => {
    class StuckStdin extends FakeStdin {
      override setRawMode(mode: boolean): this {
        if (!mode) throw new Error('stuck raw mode')
        return super.setRawMode(mode)
      }
    }
    const run = await abortedAtStart(new StuckStdin())
    try {
      await assert.rejects(run.result, /stuck raw mode/)
      assert.equal(run.closed(), true, 'the session is closed whatever setRawMode did')
    } finally {
      await run.dispose()
    }
  })
})

describe('provino jest --watch in this process, against the watch/* goldens of Jest 30.5.2', () => {
  for (const name of [...TERMINAL_IDS, 'non-interactive']) {
    it(`watch/${name}`, { timeout: SESSION_MS + 30_000 }, async () => {
      await playInProcess(await loadFixture(`watch/${name}`))
    })
  }
})

describe('provino jest --watch on a terminal, against the watch/* goldens of Jest 30.5.2', async () => {
  const skip = await terminalSkip()
  for (const name of TERMINAL_IDS) {
    it(`watch/${name}`, { skip, timeout: SESSION_MS + 30_000 }, async () => {
      await playOnTerminal(await loadFixture(`watch/${name}`))
    })
  }
})

describe('provino jest --watchAll --json: the results file of each run (runJest.ts)', () => {
  /** Runs one watch run to its results file, then ends the session; the file's `success`. */
  async function successOf(file: string): Promise<boolean> {
    const project = await makeProject({
      'jest.config.json': jestConfigJson(),
      'tests/a.test.js': file,
    })
    try {
      const terminal = new FakeTerminal(false)
      const controller = new AbortController()
      const out = project.path('out.json')
      const result = runJestCommand(
        ['--config', project.path('jest.config.json'), '--watchAll', '--json', '--outputFile', out],
        {
          stdout: terminal,
          stderr: terminal,
          cwd: project.dir,
          env: { TERM: 'xterm-256color', NO_COLOR: '1' },
          stdin: new FakeStdin(),
          signal: controller.signal,
          watchChanges: () => ({ close: () => undefined }),
        },
      )
      const deadline = Date.now() + SESSION_MS
      while (!terminal.text.includes('Test results written to')) {
        assert.ok(Date.now() < deadline, `no results file. Output:\n${terminal.text}`)
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      controller.abort()
      await result
      return (JSON.parse(await readFile(out, 'utf8')) as { success: boolean }).success
    } finally {
      await project.cleanup()
    }
  }

  it('a run whose tests all pass has success true, as the same run without --watch does', async () => {
    assert.equal(await successOf(passing('adds')), true)
  })

  it('a run with a failing test has success false', async () => {
    assert.equal(await successOf(failing('adds')), false)
  })
})
