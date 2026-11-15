// jest-core `watch.ts` L91-L472 (Jest 30.5.2) over a host: the keys, the plugins, when a run
// starts, what is written around it, and how the session ends. The host runs the tests (`provino`
// wires the orchestrator's watch session to it), so this module starts no process and watches no
// file. Third-party `watchPlugins` are B23c Phase 9's, and so are the `u` and `i` modes.
import type { TextStyle } from '@provino/types'
import type { JestGlobalConfig } from '../types.ts'
import type { JestWatchOutput, JestWatchTerminal } from './context.ts'
import { JestFailedTestsCache } from './failed-tests-cache.ts'
import { createJestHooks, type JestHookEmitter, type JestWatchResults } from './hooks.ts'
import {
  jestFailedTestsInteractivePlugin,
  jestUpdateSnapshotsInteractivePlugin,
  jestUpdateSnapshotsPlugin,
} from './interactive-plugins.ts'
import { jestWatchKeys } from './keys.ts'
import { jestTestNamePatternPlugin, jestTestPathPatternPlugin } from './pattern-plugins.ts'
import {
  filterInteractivePlugins,
  getSortedUsageRows,
  type JestWatchPlugin,
  pluginKey,
} from './plugin.ts'
import type { JestResizeSource } from './prompt.ts'
import { type JestWatchStdin, jestQuitPlugin } from './quit.ts'
import { JEST_PRE_RUN_MESSAGE, jestClearScreen, jestTerminalEscapes } from './terminal.ts'
import { type JestWatchConfigUpdate, updateJestWatchConfig } from './update-global-config.ts'
import { jestToggleUsagePrompt, jestWatchUsage } from './usage.ts'

/**
 * What a run gives back: its results (`onComplete`'s `AggregatedResult`), or `exit` when the run
 * ended watch mode itself (`--watch` with no repository, a failed changed-files lookup: the host has
 * written Jest's text).
 * @beta
 */
export type JestWatchRunOutcome =
  | { readonly kind: 'complete'; readonly results: JestWatchResults }
  | { readonly kind: 'exit'; readonly code: number }

/**
 * What the host's run gets besides the config: the failed-tests cache `--onlyFailures` reads
 * (`runJest`'s `failedTestsCache`), the hooks (`jestHooks`), and the driver's `startRun`, which a
 * reporter may call (`reporterContext.startRun`).
 * @beta
 */
export interface JestWatchRunContext {
  readonly failedTestsCache: JestFailedTestsCache
  readonly hooks: JestHookEmitter
  readonly startRun: (globalConfig: JestGlobalConfig) => void
}

/**
 * What the driver runs on. `interactive` is jest-util's `isInteractive` (a terminal, not `dumb`,
 * not CI).
 * @beta
 */
export interface JestWatchHost {
  readonly stdin: JestWatchStdin
  /** Jest's `outputStream`: stdout, or stderr under `--useStderr`. */
  readonly stdout: JestWatchOutput
  /** Where a run that threw is reported (`console.error`). */
  readonly stderr: JestWatchOutput
  readonly interactive: boolean
  readonly style: TextStyle
  /** Default `process.platform`: Windows has its own screen clear and backspace. */
  readonly platform?: NodeJS.Platform
  /** `TERM_PROGRAM` is `Apple_Terminal`: the cursor is saved with `ESC 7`. */
  readonly appleTerminal?: boolean
  readonly resizes?: JestResizeSource
  /** Runs the tests once with this config. */
  run(globalConfig: JestGlobalConfig, context: JestWatchRunContext): Promise<JestWatchRunOutcome>
  /** Interrupts the run that is going (`testWatcher.setState({ interrupted: true })`). */
  interrupt(): void
  /** Calls `listener` after each batch of relevant changes; returns the unsubscribe. */
  onFileChange(listener: () => void): () => void
  /** The text of an error a run threw (`formatExecError(error, config, { noStackTrace: false })`). */
  formatError(error: unknown): string
}

/**
 * A running watch mode.
 * @beta
 */
export interface JestWatch {
  /** Resolves with the exit code once watch mode ends (`q`, Ctrl+C, Ctrl+D: 0). */
  readonly done: Promise<number>
  /** Stops reading keys and changes, leaves raw mode. Called whatever ended the session. */
  dispose(): void
}

/**
 * Starts watch mode (`watch(initialGlobalConfig, ...)`): the first run starts now.
 *
 * One difference from Jest (D7): a change saved while a run is going starts one more run when it
 * ends, where Jest drops it (`startRun` L284-L287 returns while `isRunning`). A run that throws
 * also ends `isRunning`, where Jest's stays set and no run can start again.
 * @beta
 */
export function startJestWatch(
  initialGlobalConfig: JestGlobalConfig,
  host: JestWatchHost,
): JestWatch {
  const { stdin, interactive } = host
  const platform = host.platform ?? process.platform
  const keys = jestWatchKeys(platform)
  const escapes = jestTerminalEscapes(host.appleTerminal === true)
  const terminal: JestWatchTerminal = {
    out: host.stdout,
    style: host.style,
    escapes,
    clear: jestClearScreen(platform),
    keys,
    ...(host.resizes === undefined ? {} : { resizes: host.resizes }),
  }
  const { out } = terminal
  const { style } = host

  let resolveDone: (code: number) => void = () => {}
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve
  })
  let ended = false
  let unsubscribe: (() => void) | undefined
  const onData = (chunk: string): void => onKeypress(chunk)
  let reading = false
  const dispose = (): void => {
    unsubscribe?.()
    unsubscribe = undefined
    if (reading) {
      reading = false
      stdin.off('data', onData)
      if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false)
      stdin.pause()
    }
  }
  const exit = (code: number): void => {
    if (ended) return
    ended = true
    dispose()
    resolveDone(code)
  }

  // L105-L108: watch mode always passes with no tests.
  let globalConfig = updateJestWatchConfig(initialGlobalConfig, {
    mode: initialGlobalConfig.watch ? 'watch' : 'watchAll',
    passWithNoTests: true,
  })
  let activePlugin: JestWatchPlugin | null = null

  // L110-L156
  const updateConfigAndRun = (update: JestWatchConfigUpdate = {}): void => {
    const previousUpdateSnapshot = globalConfig.updateSnapshot
    globalConfig = updateJestWatchConfig(globalConfig, update)
    void startRun(globalConfig)
    // updateSnapshot is not sticky after a run.
    globalConfig = updateJestWatchConfig(globalConfig, {
      updateSnapshot: previousUpdateSnapshot === 'all' ? 'none' : previousUpdateSnapshot,
    })
  }

  // L67-L74 and L158-L166: Jest's own plugins in its order, each applied to the hooks.
  const hooks = createJestHooks()
  const plugins: JestWatchPlugin[] = [
    jestFailedTestsInteractivePlugin(terminal),
    jestTestPathPatternPlugin(terminal),
    jestTestNamePatternPlugin(terminal),
    jestUpdateSnapshotsPlugin(terminal),
    jestUpdateSnapshotsInteractivePlugin(terminal),
    jestQuitPlugin(terminal, stdin, exit),
  ]
  for (const plugin of plugins) plugin.apply?.(hooks.subscriber)

  const failedTestsCache = new JestFailedTestsCache()
  let isRunning = false
  let shouldDisplayWatchUsage = true
  let isWatchUsageDisplayed = false
  /** A change came while a run was going: one more run follows it (a D7 fix, see above). */
  let changedDuringRun = false

  const usage = (): string => jestWatchUsage(globalConfig, plugins, style)

  // L284-L347
  const startRun = async (config: JestGlobalConfig): Promise<void> => {
    if (isRunning || ended) return
    if (interactive) out.write(terminal.clear)
    if (interactive) out.write(style.bold(style.dim(JEST_PRE_RUN_MESSAGE)))
    isRunning = true
    let outcome: JestWatchRunOutcome
    try {
      outcome = await host.run(config, {
        failedTestsCache,
        hooks: hooks.emitter,
        startRun: (next) => void startRun(next),
      })
    } catch (error) {
      // Errors thrown inside the run are written below the pre-run message and the watch goes on.
      isRunning = false
      host.stderr.write(`\n\n${host.formatError(error)}\n`)
      rerunIfChanged()
      return
    }
    // Watch mode ended while the run went on (Ctrl+C): Jest's process is gone by then.
    if (ended) return
    if (outcome.kind === 'exit') {
      isRunning = false
      exit(outcome.code)
      return
    }
    const { results } = outcome
    // `onComplete` (L306-L331)
    isRunning = false
    hooks.emitter.onTestRunComplete(results)
    if (interactive) {
      if (shouldDisplayWatchUsage) {
        out.write(usage())
        shouldDisplayWatchUsage = false
        isWatchUsageDisplayed = true
      } else {
        out.write(jestToggleUsagePrompt(style))
        shouldDisplayWatchUsage = false
        isWatchUsageDisplayed = false
      }
    } else {
      out.write('\n')
    }
    failedTestsCache.setTestResults(results.testResults)
    rerunIfChanged()
  }

  const rerunIfChanged = (): void => {
    if (!changedDuringRun || ended) return
    changedDuringRun = false
    void startRun(globalConfig)
  }

  // L249-L272: a relevant change ends any plugin's prompt and starts a run.
  unsubscribe = host.onFileChange(() => {
    if (ended) return
    activePlugin = null
    if (isRunning) {
      changedDuringRun = true
      return
    }
    void startRun(globalConfig)
  })

  // L457-L462
  const onCancelPatternPrompt = (): void => {
    out.write(escapes.cursorHide)
    out.write(terminal.clear)
    out.write(usage())
    out.write(escapes.cursorShow)
  }

  // L349-L455
  const onKeypress = (key: string): void => {
    if (ended) return
    if (key === keys.CONTROL_C || key === keys.CONTROL_D) {
      if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false)
      out.write('\n')
      exit(0)
      return
    }
    if (activePlugin?.onKey !== undefined) {
      // An active plugin handles every key.
      activePlugin.onKey(key)
      return
    }
    // Jest compares the key with `Number(usage.key).toString(16)` (`NaN` for a letter), so a
    // plugin's own key never interrupts through this list; it does below, as Jest does.
    const pluginKeys = getSortedUsageRows(plugins, globalConfig).map((row) =>
      Number(row.key).toString(16),
    )
    if (isRunning && ['q', keys.ENTER, 'a', 'o', 'f', ...pluginKeys].includes(key)) {
      host.interrupt()
      return
    }
    const matching = filterInteractivePlugins(plugins, globalConfig).find(
      (plugin) => pluginKey(plugin, globalConfig) === key,
    )
    if (matching !== undefined) {
      if (isRunning) {
        host.interrupt()
        return
      }
      activePlugin = matching
      if (activePlugin.run !== undefined) {
        activePlugin.run(globalConfig, updateConfigAndRun).then(
          (shouldRerun) => {
            activePlugin = null
            if (shouldRerun) updateConfigAndRun()
          },
          () => {
            activePlugin = null
            onCancelPatternPrompt()
          },
        )
      } else {
        activePlugin = null
      }
    }
    switch (key) {
      case keys.ENTER:
        void startRun(globalConfig)
        break
      case 'a':
        globalConfig = updateJestWatchConfig(globalConfig, {
          mode: 'watchAll',
          testNamePattern: '',
          testPathPatterns: [],
        })
        void startRun(globalConfig)
        break
      case 'c':
        updateConfigAndRun({ mode: 'watch', testNamePattern: '', testPathPatterns: [] })
        break
      case 'f':
        globalConfig = updateJestWatchConfig(globalConfig, {
          onlyFailures: !globalConfig.onlyFailures,
        })
        void startRun(globalConfig)
        break
      case 'o':
        globalConfig = updateJestWatchConfig(globalConfig, {
          mode: 'watch',
          testNamePattern: '',
          testPathPatterns: [],
        })
        void startRun(globalConfig)
        break
      case 'w':
        if (!shouldDisplayWatchUsage && !isWatchUsageDisplayed) {
          out.write(escapes.cursorUp())
          out.write(escapes.eraseDown)
          out.write(usage())
          isWatchUsageDisplayed = true
          shouldDisplayWatchUsage = false
        }
        break
    }
  }

  // L464-L469: keys are read only from a terminal.
  if (typeof stdin.setRawMode === 'function') {
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    stdin.on('data', onData)
    reading = true
  }

  void startRun(globalConfig)
  return { done, dispose }
}
