// The watch driver over a fake terminal and a fake host: no process, no file watching and no real
// waits. Each run is a promise the test settles, so every ordering (a key during a run, a change
// during a run, a run that throws) is driven by hand.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { TextStyle } from '@provino/types'
import type { JestGlobalConfig } from '../types.ts'
import type { JestWatchResults } from './hooks.ts'
import type { JestWatchStdin } from './quit.ts'
import { jestClearScreen, jestStringLength, jestTerminalEscapes } from './terminal.ts'
import { updateJestWatchConfig } from './update-global-config.ts'
import { jestActiveFilters, jestToggleUsagePrompt, jestWatchUsage } from './usage.ts'
import {
  type JestWatchHost,
  type JestWatchRunContext,
  type JestWatchRunOutcome,
  startJestWatch,
} from './watch.ts'

const plain: TextStyle = {
  bold: (text) => text,
  dim: (text) => text,
  red: (text) => text,
  green: (text) => text,
  yellow: (text) => text,
  magenta: (text) => text,
  inverse: (text) => text,
  badge: (word) => word,
}

/** The global config fields the driver reads, the rest left at Jest's defaults' shape. */
function config(overrides: Partial<JestGlobalConfig> = {}): JestGlobalConfig {
  return {
    watch: false,
    watchAll: true,
    onlyChanged: false,
    onlyFailures: false,
    testPathPatterns: [],
    testNamePattern: undefined,
    updateSnapshot: 'new',
    passWithNoTests: false,
    coverageDirectory: '/root/coverage',
    noSCM: undefined,
    ...overrides,
  } as JestGlobalConfig
}

const CLEAR = jestClearScreen('linux')
const ESC = jestTerminalEscapes(false)
const PRE_RUN = 'Determining test suites to run...'
const WATCH_ALL_USAGE =
  '\nWatch Usage\n › Press f to run only failed tests.\n › Press o to only run tests related to changed files.\n › Press p to filter by a filename regex pattern.\n › Press t to filter by a test name regex pattern.\n › Press q to quit watch mode.\n › Press Enter to trigger a test run.\n'

function results(failed: readonly string[] = [], snapshotFailure = false): JestWatchResults {
  return {
    numFailedTests: failed.length,
    snapshot: { failure: snapshotFailure, unmatched: snapshotFailure ? 1 : 0 },
    testResults: failed.map((path) => ({
      testFilePath: path,
      numFailingTests: 1,
      ...(snapshotFailure ? { snapshot: { unmatched: 1 } } : {}),
      testResults: [{ fullName: `${path} fails`, status: 'failed' }],
    })),
  }
}

interface PendingRun {
  readonly config: JestGlobalConfig
  readonly context: JestWatchRunContext
  settle(outcome: JestWatchRunOutcome): Promise<void>
  fail(error: unknown): Promise<void>
}

/** Lets every promise callback queued so far run. */
async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

function setUp(options: { interactive?: boolean; tty?: boolean; initial?: JestGlobalConfig } = {}) {
  let output = ''
  let errors = ''
  const runs: PendingRun[] = []
  const rawModes: boolean[] = []
  let listener: ((chunk: string) => void) | undefined
  let paused = false
  let changeListener: (() => void) | undefined
  let interrupts = 0
  const stdin: JestWatchStdin = {
    ...(options.tty === false ? {} : { setRawMode: (mode: boolean) => rawModes.push(mode) }),
    resume: () => {
      paused = false
    },
    pause: () => {
      paused = true
    },
    setEncoding: () => {},
    on: (_event, fn) => {
      listener = fn
    },
    off: (_event, fn) => {
      if (listener === fn) listener = undefined
    },
  }
  const host: JestWatchHost = {
    stdin,
    stdout: { write: (text) => (output += text) },
    stderr: { write: (text) => (errors += text) },
    interactive: options.interactive ?? true,
    style: plain,
    platform: 'linux',
    run: (runConfig, context) =>
      new Promise((resolve, reject) => {
        runs.push({
          config: runConfig,
          context,
          settle: async (outcome) => {
            resolve(outcome)
            await flush()
          },
          fail: async (error) => {
            reject(error)
            await flush()
          },
        })
      }),
    interrupt: () => {
      interrupts += 1
    },
    onFileChange: (fn) => {
      changeListener = fn
      return () => {
        changeListener = undefined
      }
    },
    formatError: (error) => `formatted: ${(error as Error).message}`,
  }
  const watch = startJestWatch(options.initial ?? config(), host)
  return {
    watch,
    runs,
    rawModes,
    output: () => output,
    errors: () => errors,
    clearOutput: () => {
      output = ''
    },
    press: async (key: string) => {
      assert.ok(listener !== undefined, 'the driver reads keys')
      listener(key)
      await flush()
    },
    change: async () => {
      changeListener?.()
      await flush()
    },
    reading: () => listener !== undefined,
    paused: () => paused,
    hasChangeListener: () => changeListener !== undefined,
    interrupts: () => interrupts,
    last: (): PendingRun => {
      const run = runs.at(-1)
      assert.ok(run !== undefined, 'a run started')
      return run
    },
  }
}

const complete = (value: JestWatchResults = results()): JestWatchRunOutcome => ({
  kind: 'complete',
  results: value,
})

describe('the usage text (watch.ts L536-L590)', () => {
  const plugins = [
    { isInternal: true as const, getUsageInfo: () => ({ key: 'q', prompt: 'quit watch mode' }) },
  ]

  it('under --watchAll: f, o, the plugins, Enter', () => {
    assert.equal(
      jestWatchUsage(updateJestWatchConfig(config(), { mode: 'watchAll' }), plugins, plain),
      '\nWatch Usage\n › Press f to run only failed tests.\n › Press o to only run tests related to changed files.\n › Press q to quit watch mode.\n › Press Enter to trigger a test run.\n',
    )
  })

  it('under --watch: a and no o', () => {
    assert.equal(
      jestWatchUsage(updateJestWatchConfig(config(), { mode: 'watch' }), plugins, plain),
      '\nWatch Usage\n › Press a to run all tests.\n › Press f to run only failed tests.\n › Press q to quit watch mode.\n › Press Enter to trigger a test run.\n',
    )
  })

  it('with filters: Active Filters, c, and o under --watch too', () => {
    const filtered = updateJestWatchConfig(config(), {
      mode: 'watch',
      testPathPatterns: ['foo', 'bar'],
      testNamePattern: 'beta',
    })
    assert.equal(
      jestWatchUsage(filtered, [], plain),
      '\nActive Filters: filename foo|bar, test name /beta/\n › Press c to clear filters.\n\nWatch Usage\n › Press a to run all tests.\n › Press f to run only failed tests.\n › Press o to only run tests related to changed files.\n › Press Enter to trigger a test run.\n',
    )
    assert.equal(jestActiveFilters(config(), plain), '')
  })

  it('in only-failures mode the f row says how to leave it', () => {
    assert.match(
      jestWatchUsage(config({ onlyFailures: true }), [], plain),
      / › Press f to quit "only failed tests" mode\./,
    )
  })

  it('the toggle line', () => {
    assert.equal(jestToggleUsagePrompt(plain), '\nWatch Usage: Press w to show more.')
  })
})

describe('updateGlobalConfig (L16-L110)', () => {
  it('works out onlyChanged again and freezes the copy', () => {
    const watch = updateJestWatchConfig(config(), { mode: 'watch' })
    assert.equal(watch.onlyChanged, true)
    assert.equal(Object.isFrozen(watch), true)
    assert.equal(updateJestWatchConfig(watch, { testPathPatterns: ['x'] }).onlyChanged, false)
    assert.equal(updateJestWatchConfig(watch, { testNamePattern: 'x' }).onlyChanged, false)
    assert.equal(updateJestWatchConfig(watch, { mode: 'watchAll' }).onlyChanged, false)
    assert.equal(updateJestWatchConfig(config(), { bail: true }).bail, 1)
    assert.equal(updateJestWatchConfig(config(), { passWithNoTests: true }).passWithNoTests, true)
  })
})

describe('the driver', () => {
  it('starts a run at once under passWithNoTests, then shows the usage once and the toggle after', async () => {
    const t = setUp()
    assert.deepEqual(t.rawModes, [true])
    assert.equal(t.output(), `${CLEAR}${PRE_RUN}`)
    assert.equal(t.last().config.passWithNoTests, true)
    assert.equal(t.last().config.watchAll, true)
    await t.last().settle(complete())
    assert.match(t.output(), /\nWatch Usage\n › Press f/)
    t.clearOutput()
    await t.press('\r')
    assert.equal(t.runs.length, 2)
    await t.last().settle(complete())
    assert.equal(t.output(), `${CLEAR}${PRE_RUN}\nWatch Usage: Press w to show more.`)
    t.watch.dispose()
  })

  it('w shows the whole usage again after the toggle line, once', async () => {
    const t = setUp()
    await t.last().settle(complete())
    await t.press('\r')
    await t.last().settle(complete())
    t.clearOutput()
    await t.press('w')
    assert.equal(t.output(), `${ESC.cursorUp()}${ESC.eraseDown}${WATCH_ALL_USAGE}`)
    t.clearOutput()
    await t.press('w')
    assert.equal(t.output(), '')
    t.watch.dispose()
  })

  it('a runs everything, o selects by changes, f toggles only-failures, c clears the filters', async () => {
    const t = setUp({ initial: config({ watch: true, watchAll: false }) })
    assert.equal(t.last().config.onlyChanged, true)
    await t.last().settle(complete())
    await t.press('a')
    assert.equal(t.last().config.watchAll, true)
    assert.equal(t.last().config.onlyChanged, false)
    await t.last().settle(complete())
    await t.press('o')
    assert.equal(t.last().config.watch, true)
    assert.equal(t.last().config.onlyChanged, true)
    await t.last().settle(complete())
    await t.press('f')
    assert.equal(t.last().config.onlyFailures, true)
    await t.last().settle(complete())
    await t.press('f')
    assert.equal(t.last().config.onlyFailures, false)
    await t.last().settle(complete())
    await t.press('c')
    assert.equal(t.last().config.watch, true)
    assert.deepEqual(t.last().config.testPathPatterns, [])
    assert.equal(t.last().config.testNamePattern, '')
    assert.equal(t.runs.length, 6)
    t.watch.dispose()
  })

  it('p draws the pattern screen and the caret, and Enter runs with the pattern', async () => {
    const t = setUp()
    await t.last().settle(complete())
    t.clearOutput()
    await t.press('p')
    const caret = (text: string): string =>
      `${ESC.eraseLine}${ESC.cursorLeft}${ESC.eraseDown} pattern › ${text}${ESC.cursorSavePosition}${ESC.cursorTo(jestStringLength(` pattern › ${text}`), 5)}${ESC.cursorRestorePosition}`
    assert.equal(
      t.output(),
      `${ESC.cursorHide}${CLEAR}\nPattern Mode Usage\n › Press Esc to exit pattern mode.\n › Press Enter to filter by a filenames regex pattern.\n\n${ESC.cursorShow}${caret('')}`,
    )
    t.clearOutput()
    await t.press('f')
    await t.press('o')
    assert.equal(t.output(), `${caret('f')}${caret('fo')}`)
    // Backspace takes the last character back.
    t.clearOutput()
    await t.press('\u007F')
    assert.equal(t.output(), caret('f'))
    await t.press('o')
    await t.press('o')
    assert.equal(t.runs.length, 1, 'keys typed into the prompt start nothing')
    await t.press('\r')
    assert.equal(t.runs.length, 2)
    assert.deepEqual(t.last().config.testPathPatterns, ['foo'])
    assert.equal(t.last().config.watch, true)
    await t.last().settle(complete())
    t.watch.dispose()
  })

  it('an Active Filters header moves the caret down by its lines', async () => {
    const t = setUp({ initial: config({ testPathPatterns: ['foo'] }) })
    await t.last().settle(complete())
    t.clearOutput()
    await t.press('t')
    assert.ok(t.output().includes('\nActive Filters: filename foo\n\nPattern Mode Usage'))
    // The usage's 6 rows and the header's 2: the caret's row is 7 (0-based).
    assert.ok(t.output().includes(ESC.cursorTo(jestStringLength(' pattern › '), 7)))
    await t.press('b')
    await t.press('\r')
    assert.equal(t.last().config.testNamePattern, 'b')
    assert.deepEqual(t.last().config.testPathPatterns, ['foo'])
    await t.last().settle(complete())
    t.watch.dispose()
  })

  it("Esc leaves the prompt and draws the usage again; a key after it is the driver's again", async () => {
    const t = setUp()
    await t.last().settle(complete())
    await t.press('p')
    await t.press('x')
    t.clearOutput()
    await t.press('\u001B')
    assert.equal(t.output(), `${ESC.cursorHide}${CLEAR}${WATCH_ALL_USAGE}${ESC.cursorShow}`)
    assert.equal(t.runs.length, 1)
    await t.press('\r')
    assert.equal(t.runs.length, 2)
    await t.last().settle(complete())
    t.watch.dispose()
  })

  it('q leaves raw mode, writes a newline and ends with 0; nothing is read after', async () => {
    const t = setUp()
    await t.last().settle(complete())
    t.clearOutput()
    await t.press('q')
    assert.equal(await t.watch.done, 0)
    assert.equal(t.output(), '\n')
    assert.deepEqual(t.rawModes.at(-1), false)
    assert.equal(t.reading(), false)
    assert.equal(t.paused(), true)
    assert.equal(t.hasChangeListener(), false)
  })

  for (const [name, key] of [
    ['Ctrl+C', '\u0003'],
    ['Ctrl+D', '\u0004'],
  ] as const) {
    it(`${name} ends with 0 even while a run is going`, async () => {
      const t = setUp()
      t.clearOutput()
      await t.press(key)
      assert.equal(await t.watch.done, 0)
      assert.equal(t.output(), '\n')
      assert.equal(t.rawModes.at(-1), false)
      // The run that was going ends with nothing more written.
      await t.last().settle(complete())
      assert.equal(t.output(), '\n')
    })
  }

  it('a key while a run is going interrupts it: q, Enter, a, o, f and a plugin key; others do not', async () => {
    const t = setUp()
    for (const key of ['q', '\r', 'a', 'o', 'f', 'p', 't']) await t.press(key)
    assert.equal(t.interrupts(), 7)
    assert.equal(t.runs.length, 1, 'no second run starts while one is going')
    await t.press('w')
    await t.press('x')
    assert.equal(t.interrupts(), 7)
    await t.last().settle(complete())
    t.watch.dispose()
  })

  it('a change starts a run; a change during a run starts one more after it (D7)', async () => {
    const t = setUp()
    await t.change()
    await t.change()
    assert.equal(t.runs.length, 1)
    await t.last().settle(complete())
    assert.equal(t.runs.length, 2, 'the changes during the first run gave one more run')
    await t.last().settle(complete())
    assert.equal(t.runs.length, 2)
    await t.change()
    assert.equal(t.runs.length, 3)
    await t.last().settle(complete())
    t.watch.dispose()
  })

  it("a change ends an open prompt: the next key is the driver's", async () => {
    const t = setUp()
    await t.last().settle(complete())
    await t.press('p')
    await t.change()
    await t.last().settle(complete())
    assert.equal(t.runs.length, 2)
    await t.press('\r')
    assert.equal(t.runs.length, 3)
    assert.deepEqual(t.last().config.testPathPatterns, [])
    await t.last().settle(complete())
    t.watch.dispose()
  })

  it('updateSnapshot is not sticky: a run with "all" is followed by "none" (L151-L155)', async () => {
    const t = setUp({ initial: config({ updateSnapshot: 'all' }) })
    assert.equal(t.last().config.updateSnapshot, 'all')
    await t.last().settle(complete())
    // `c` goes through updateConfigAndRun, which resets afterwards.
    await t.press('c')
    assert.equal(t.last().config.updateSnapshot, 'all')
    await t.last().settle(complete())
    await t.press('\r')
    assert.equal(t.last().config.updateSnapshot, 'none')
    await t.last().settle(complete())
    t.watch.dispose()
  })

  it('the failed-tests cache and the hooks hear each run; the i row follows a failure', async () => {
    const t = setUp()
    const { failedTestsCache } = t.last().context
    await t.last().settle(complete(results(['/root/fail.test.ts'])))
    assert.match(
      t.output(),
      / › Press q to quit watch mode\.\n › Press i to run failing tests interactively\.\n › Press Enter/,
    )
    assert.deepEqual(
      failedTestsCache.filterPaths([
        { path: '/root/fail.test.ts' },
        { path: '/root/pass.test.ts' },
      ]),
      [{ path: '/root/fail.test.ts' }],
    )
    t.clearOutput()
    await t.press('i')
    assert.match(
      t.output(),
      /Provino: watch mode's interactive failed-tests mode \(`i`\) is not supported yet \(B23c Phase 9\)\./,
    )
    assert.equal(t.runs.length, 1)
    t.watch.dispose()
  })

  it('a snapshot failure lists u and the snapshot i, which hides the failed-tests i', async () => {
    const t = setUp()
    await t.last().settle(complete(results(['/root/snap.test.ts'], true)))
    assert.match(
      t.output(),
      / › Press t to filter by a test name regex pattern\.\n › Press u to update failing snapshots\.\n › Press i to update failing snapshots interactively\.\n › Press q to quit watch mode\./,
    )
    await t.press('u')
    assert.match(t.output(), /snapshot update \(`u`\) is not supported yet/)
    t.watch.dispose()
  })

  it('a run that exits (no repository under --watch) ends watch mode with its code', async () => {
    const t = setUp({ initial: config({ watch: true, watchAll: false }) })
    await t.last().settle({ kind: 'exit', code: 1 })
    assert.equal(await t.watch.done, 1)
    assert.equal(t.reading(), false)
  })

  it('a run that throws is reported, and the next key runs again (Jest stays running, D7)', async () => {
    const t = setUp()
    await t.last().fail(new Error('resolver broke'))
    assert.equal(t.errors(), '\n\nformatted: resolver broke\n')
    await t.press('\r')
    assert.equal(t.runs.length, 2)
    await t.last().settle(complete())
    t.watch.dispose()
  })

  it('a reporter may start a run through the context, dropped while one is going', async () => {
    const t = setUp()
    t.last().context.startRun(t.last().config)
    await Promise.resolve()
    assert.equal(t.runs.length, 1)
    await t.last().settle(complete())
    t.last().context.startRun(t.last().config)
    await Promise.resolve()
    assert.equal(t.runs.length, 2)
    await t.last().settle(complete())
    t.watch.dispose()
  })

  it('not interactive: no clear, no pre-run text, no usage, a newline after each run', async () => {
    const t = setUp({ interactive: false })
    assert.equal(t.output(), '')
    await t.last().settle(complete())
    assert.equal(t.output(), '\n')
    await t.change()
    await t.last().settle(complete())
    assert.equal(t.output(), '\n\n')
    t.watch.dispose()
  })

  it('reads no key from input that is not a terminal (no setRawMode)', () => {
    const t = setUp({ tty: false })
    assert.equal(t.reading(), false)
    assert.deepEqual(t.rawModes, [])
    t.watch.dispose()
  })

  it('dispose leaves raw mode and stops listening', () => {
    const t = setUp()
    t.watch.dispose()
    assert.deepEqual(t.rawModes, [true, false])
    assert.equal(t.reading(), false)
    assert.equal(t.hasChangeListener(), false)
  })

  it('dispose ends the driver: a run still going prints nothing when the close rejects it, and nothing starts', async () => {
    const t = setUp()
    t.watch.dispose()
    await t.last().fail(new Error('The watch session is closed.'))
    assert.equal(t.errors(), '')
    await t.change()
    assert.equal(t.runs.length, 1, 'no run starts on a closed session')
  })

  it('dispose with a change pending starts no run when the one going ends', async () => {
    const t = setUp()
    await t.change()
    t.watch.dispose()
    await t.last().settle(complete())
    assert.equal(t.runs.length, 1)
  })
})
