// Third-party watch plugins (jest-core `watch.ts` L168-L219, L474-L534): the conflict check and its
// two texts, the identifier and the key, a plugin that fails to load, and a plugin hosted by the
// driver (its row, its key, `shouldRunTestSuite`'s emitter, `onFileChange` before the first run).
// The plugins are CommonJS files in a temp directory; the driver runs over a fake host, no waits.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TextStyle } from '@provino/types'
import { afterAll, beforeAll, describe, it } from 'provino'
import type { JestGlobalConfig } from '../types.ts'
import type { JestFileChange } from './hooks.ts'
import {
  jestFailedTestsInteractivePlugin,
  jestUpdateSnapshotsInteractivePlugin,
  jestUpdateSnapshotsPlugin,
} from './interactive-plugins.ts'
import { jestWatchKeys } from './keys.ts'
import { jestTestNamePatternPlugin, jestTestPathPatternPlugin } from './pattern-plugins.ts'
import type { JestWatchPlugin } from './plugin.ts'
import {
  checkJestWatchPluginConflicts,
  getJestPluginIdentifier,
  getJestPluginKey,
  JestWatchPluginError,
  jestWatchPluginKeys,
  loadJestWatchPlugin,
} from './plugin-host.ts'
import { type JestWatchStdin, jestQuitPlugin } from './quit.ts'
import { jestClearScreen, jestTerminalEscapes } from './terminal.ts'
import { type JestWatchHost, type JestWatchRunContext, startJestWatch } from './watch.ts'

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
    watchPlugins: undefined,
    ...overrides,
  } as JestGlobalConfig
}

const keyed = (key: string): JestWatchPlugin => ({ getUsageInfo: () => ({ key, prompt: key }) })

const stdin: JestWatchStdin = {
  resume: () => {},
  pause: () => {},
  setEncoding: () => {},
  on: () => {},
  off: () => {},
}

let dir = ''
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'provino-watch-plugins-'))
  const files: Record<string, string> = {
    'claims-u.cjs':
      "class ClaimsU {\n  getUsageInfo() {\n    return { key: 'u', prompt: 'other' }\n  }\n}\nmodule.exports = ClaimsU\n",
    'named.cjs':
      "class Inner {\n  getUsageInfo() {\n    return { key: 'z', prompt: 'z' }\n  }\n}\nInner.displayName = 'Shown'\nmodule.exports = Inner\n",
    'throws-on-change.cjs': [
      'class ThrowsOnChange {',
      '  constructor({ config }) {',
      '    this.throwAt = config.throwAt',
      '    this.calls = 0',
      '  }',
      '  apply(hooks) {',
      '    hooks.onFileChange(() => {',
      '      this.calls += 1',
      "      if (this.calls === this.throwAt) throw new Error('plugin broke')",
      '    })',
      '  }',
      '}',
      'module.exports = ThrowsOnChange',
      '',
    ].join('\n'),
    'usage-empty.cjs': 'module.exports = class { getUsageInfo() { return {} } }\n',
    'usage-prompt-only.cjs':
      "module.exports = class { getUsageInfo() { return { prompt: 'x' } } }\n",
    'usage-numeric.cjs':
      "module.exports = class { getUsageInfo() { return { key: 5, prompt: 'five' } } }\n",
    'throws.cjs': "throw new Error('broken plugin')\n",
    'not-a-class.cjs': 'module.exports = 42\n',
    'custom.cjs': [
      'class Custom {',
      '  constructor({ config, stdin, stdout }) {',
      '    this.seen = { config, hasStdin: stdin !== undefined, hasStdout: stdout !== undefined }',
      '    globalThis.__provinoPlugin = this',
      '    this.changes = []',
      '    this.runs = 0',
      '  }',
      '  apply(hooks) {',
      "    hooks.shouldRunTestSuite(({ testPath }) => !testPath.endsWith('skip.test.ts'))",
      '    hooks.onFileChange((change) => this.changes.push(change))',
      '  }',
      '  getUsageInfo() {',
      "    return { key: 'x', prompt: 'run the custom plugin' }",
      '  }',
      '  run() {',
      '    this.runs += 1',
      '    return Promise.resolve(true)',
      '  }',
      '}',
      'module.exports = Custom',
      '',
    ].join('\n'),
  }
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text)
})
afterAll(() => rm(dir, { recursive: true, force: true }))

const loadOptions = {
  stdin,
  stdout: { write: () => true },
  style: plain,
  cwd: '/',
  formatError: (error: unknown) => `formatted: ${(error as Error).message}`,
}

describe('checkForConflicts (L474-L515)', () => {
  it('a reserved key is refused with the "reserved internally" text', async () => {
    const u = keyed('u')
    const keys = jestWatchPluginKeys(
      [u],
      new Map([[u, { key: 'u', forbiddenOverwriteMessage: 'updating snapshots' }]]),
      config(),
    )
    const plugin = await loadJestWatchPlugin(
      { path: join(dir, 'claims-u.cjs'), config: {} },
      loadOptions,
    )
    assert.throws(
      () => checkJestWatchPluginConflicts(keys, plugin, config(), plain),
      (error: unknown) =>
        error instanceof JestWatchPluginError &&
        error.code === 'JEST_WATCH_PLUGIN_CONFLICT' &&
        error.message ===
          'Watch plugin configuration error:\n\nWatch plugin ClaimsU attempted to register key <u>,\n  that is reserved internally for updating snapshots.\n  Please change the configuration key for this plugin.\n',
    )
  })

  it("Jest's own overwritable key is taken over, then a second plugin on it is refused", async () => {
    const p = keyed('p')
    const keys = jestWatchPluginKeys([p], new Map(), config())
    const first = await loadJestWatchPlugin(
      { path: join(dir, 'named.cjs'), config: {} },
      loadOptions,
    )
    const second = await loadJestWatchPlugin(
      { path: join(dir, 'named.cjs'), config: {} },
      loadOptions,
    )
    const z = keyed('z')
    checkJestWatchPluginConflicts(
      jestWatchPluginKeys([z], new Map(), config()),
      first,
      config(),
      plain,
    )
    checkJestWatchPluginConflicts(keys, first, config(), plain)
    assert.equal(keys.get('z')?.plugin, first)
    assert.throws(
      () => checkJestWatchPluginConflicts(keys, second, config(), plain),
      (error: unknown) =>
        error instanceof JestWatchPluginError &&
        error.message ===
          'Watch plugin configuration error:\n\nWatch plugins Shown and Shown both attempted to register key <z>.\n  Please change the key configuration for one of the conflicting plugins to avoid overlap.\n',
    )
  })

  it("Jest's own plugins are named as Jest's classes are, in the conflict text", () => {
    const terminal = {
      out: { write: () => true },
      style: plain,
      escapes: jestTerminalEscapes(false),
      clear: jestClearScreen('linux'),
      keys: jestWatchKeys('linux'),
    }
    const pathPlugin = jestTestPathPatternPlugin(terminal)
    const named: [JestWatchPlugin, string][] = [
      [jestUpdateSnapshotsPlugin(), 'UpdateSnapshotsPlugin'],
      [jestUpdateSnapshotsInteractivePlugin(terminal), 'UpdateSnapshotInteractivePlugin'],
      [pathPlugin, 'TestPathPatternPlugin'],
      [jestTestNamePatternPlugin(terminal), 'TestNamePatternPlugin'],
      [jestQuitPlugin(terminal, stdin, () => {}), 'QuitPlugin'],
      [jestFailedTestsInteractivePlugin(terminal), 'FailedTestsInteractivePlugin'],
    ]
    for (const [plugin, name] of named) assert.equal(getJestPluginIdentifier(plugin), name)
    const keys = jestWatchPluginKeys([], new Map(), config())
    keys.set('p', { overwritable: false, plugin: pathPlugin })
    assert.throws(
      () => checkJestWatchPluginConflicts(keys, keyed('p'), config(), plain),
      (error: unknown) =>
        error instanceof JestWatchPluginError &&
        error.message.includes('Watch plugins TestPathPatternPlugin and Object both attempted'),
    )
  })

  it('a plugin with no key takes none; the key comes from getUsageInfo', () => {
    const keys = jestWatchPluginKeys([], new Map(), config())
    checkJestWatchPluginConflicts(keys, {}, config(), plain)
    assert.equal(keys.size, 0)
    assert.equal(getJestPluginKey({}, config()), null)
    assert.equal(getJestPluginKey({ getUsageInfo: () => null }, config()), null)
    assert.equal(getJestPluginKey(keyed('k'), config()), 'k')
  })

  it("the identifier is the class's displayName, else its name", async () => {
    const named = await loadJestWatchPlugin(
      { path: join(dir, 'named.cjs'), config: {} },
      loadOptions,
    )
    const plain2 = await loadJestWatchPlugin(
      { path: join(dir, 'claims-u.cjs'), config: {} },
      loadOptions,
    )
    assert.equal(getJestPluginIdentifier(named), 'Shown')
    assert.equal(getJestPluginIdentifier(plain2), 'ClaimsU')
  })
})

describe('loading a plugin (L199-L220)', () => {
  it('a module that throws is "Failed to initialize watch plugin", the path relative', async () => {
    await assert.rejects(
      loadJestWatchPlugin(
        { path: join(dir, 'throws.cjs'), config: {} },
        { ...loadOptions, cwd: dir },
      ),
      (error: unknown) =>
        error instanceof JestWatchPluginError &&
        error.code === 'JEST_WATCH_PLUGIN_LOAD' &&
        error.message ===
          'Error: Failed to initialize watch plugin "throws.cjs":\n\nformatted: broken plugin',
    )
  })

  it('a usage row is passed through as the plugin gave it: no key means no row and no key', async () => {
    const rows: [string, unknown][] = [
      ['usage-empty.cjs', null],
      ['usage-prompt-only.cjs', null],
      ['usage-numeric.cjs', { key: 5, prompt: 'five' }],
    ]
    for (const [file, expected] of rows) {
      const plugin = await loadJestWatchPlugin({ path: join(dir, file), config: {} }, loadOptions)
      assert.deepEqual(plugin.getUsageInfo?.(config()), expected, file)
    }
    const empty = await loadJestWatchPlugin(
      { path: join(dir, 'usage-empty.cjs'), config: {} },
      loadOptions,
    )
    assert.equal(getJestPluginKey(empty, config()), null)
    const keys = jestWatchPluginKeys([], new Map(), config())
    checkJestWatchPluginConflicts(keys, empty, config(), plain)
    assert.equal(keys.size, 0, 'no key, no conflict')
    const numeric = await loadJestWatchPlugin(
      { path: join(dir, 'usage-numeric.cjs'), config: {} },
      loadOptions,
    )
    assert.equal(Number(getJestPluginKey(numeric, config())), 5)
  })

  it('an export that is not a class fails the same way', async () => {
    await assert.rejects(
      loadJestWatchPlugin({ path: join(dir, 'not-a-class.cjs'), config: {} }, loadOptions),
      /Failed to initialize watch plugin[\s\S]*ThirdPartyPlugin is not a constructor/,
    )
  })
})

describe('the driver with a third-party plugin', () => {
  function host(
    overrides: Partial<JestWatchHost>,
    runs: JestWatchRunContext[],
    output: { text: string },
  ): JestWatchHost {
    let listener: ((chunk: string) => void) | undefined
    const keyStdin: JestWatchStdin & { press(key: string): void } = {
      setRawMode: () => {},
      resume: () => {},
      pause: () => {},
      setEncoding: () => {},
      on: (_event, fn) => {
        listener = fn
      },
      off: () => {
        listener = undefined
      },
      press: (key) => listener?.(key),
    }
    return {
      stdin: keyStdin,
      stdout: { write: (text) => (output.text += text) },
      stderr: { write: (text) => (output.text += text) },
      interactive: true,
      style: plain,
      platform: 'linux',
      run: (_config, context) => {
        runs.push(context)
        return Promise.resolve({
          kind: 'complete',
          results: {
            numFailedTests: 0,
            snapshot: { failure: false, unmatched: 0 },
            testResults: [],
          },
        })
      },
      interrupt: () => {},
      onFileChange: () => () => {},
      formatError: (error) => String(error),
      ...overrides,
    }
  }

  it('loads it with its config, tells it the test files before the first run, lists its row and runs its key', async () => {
    const runs: JestWatchRunContext[] = []
    const output = { text: '' }
    const change: JestFileChange = {
      projects: [
        { config: { rootDir: '/root' }, testPaths: ['/root/a.test.ts', '/root/skip.test.ts'] },
      ],
    }
    const watchHost = host({ listTests: () => Promise.resolve(change) }, runs, output)
    const watch = startJestWatch(
      config({ watchPlugins: [{ path: join(dir, 'custom.cjs'), config: { skip: 'skip' } }] }),
      watchHost,
    )
    for (let i = 0; i < 20 && runs.length === 0; i += 1) await new Promise(setImmediate)
    const plugin = Reflect.get(globalThis, '__provinoPlugin') as {
      seen: unknown
      changes: unknown[]
      runs: number
    }
    assert.deepEqual(plugin.seen, { config: { skip: 'skip' }, hasStdin: true, hasStdout: true })
    assert.deepEqual(plugin.changes, [change], 'onFileChange before the first run')
    assert.equal(runs.length, 1)
    const [first] = runs
    assert.ok(first !== undefined)
    assert.equal(first.usesShouldRunTestSuite(), true)
    assert.equal(
      await first.hooks.shouldRunTestSuite({
        config: {},
        duration: undefined,
        testPath: '/r/a.test.ts',
      }),
      true,
    )
    assert.equal(
      await first.hooks.shouldRunTestSuite({
        config: {},
        duration: undefined,
        testPath: '/r/skip.test.ts',
      }),
      false,
    )
    assert.match(
      output.text,
      / › Press q to quit watch mode\.\n › Press x to run the custom plugin\.\n/,
    )
    ;(watchHost.stdin as JestWatchStdin & { press(key: string): void }).press('x')
    for (let i = 0; i < 20 && runs.length < 2; i += 1) await new Promise(setImmediate)
    assert.equal(plugin.runs, 1)
    assert.equal(runs.length, 2, 'run resolved true: one more run')
    watch.dispose()
    Reflect.deleteProperty(globalThis, '__provinoPlugin')
  })

  it('with no plugin on shouldRunTestSuite the host is told to skip the per-file calls', async () => {
    const runs: JestWatchRunContext[] = []
    const watch = startJestWatch(config(), host({}, runs, { text: '' }))
    for (let i = 0; i < 20 && runs.length === 0; i += 1) await new Promise(setImmediate)
    assert.equal(runs[0]?.usesShouldRunTestSuite(), false)
    watch.dispose()
  })

  it('a conflicting plugin rejects done before any run', { timeout: 10_000 }, async () => {
    const runs: JestWatchRunContext[] = []
    const watch = startJestWatch(
      config({ watchPlugins: [{ path: join(dir, 'claims-u.cjs'), config: {} }] }),
      host({}, runs, { text: '' }),
    )
    await assert.rejects(watch.done, (error: unknown) => error instanceof JestWatchPluginError)
    assert.equal(runs.length, 0)
  })

  const change: JestFileChange = { projects: [{ config: {}, testPaths: ['/root/a.test.ts'] }] }

  it('a plugin whose onFileChange throws at start ends the session with its stack, no run', async () => {
    const runs: JestWatchRunContext[] = []
    const watch = startJestWatch(
      config({
        watchPlugins: [{ path: join(dir, 'throws-on-change.cjs'), config: { throwAt: 1 } }],
      }),
      host({ listTests: () => Promise.resolve(change) }, runs, { text: '' }),
    )
    await assert.rejects(
      watch.done,
      (error: unknown) =>
        error instanceof JestWatchPluginError &&
        error.code === 'JEST_WATCH_PLUGIN_HOOK' &&
        error.message.includes('Error: plugin broke'),
    )
    assert.equal(runs.length, 0)
  })

  it('a plugin whose onFileChange throws on a change ends the session too', async () => {
    const runs: JestWatchRunContext[] = []
    let changed: (() => void) | undefined
    const watch = startJestWatch(
      config({
        watchPlugins: [{ path: join(dir, 'throws-on-change.cjs'), config: { throwAt: 2 } }],
      }),
      host(
        {
          listTests: () => Promise.resolve(change),
          onFileChange: (listener) => {
            changed = listener
            return () => {}
          },
        },
        runs,
        { text: '' },
      ),
    )
    for (let i = 0; i < 20 && runs.length === 0; i += 1) await new Promise(setImmediate)
    assert.equal(runs.length, 1)
    changed?.()
    await assert.rejects(
      watch.done,
      (error: unknown) =>
        error instanceof JestWatchPluginError && error.code === 'JEST_WATCH_PLUGIN_HOOK',
    )
  })

  it('a change starts its run without waiting for the listing the plugins hear', async () => {
    const runs: JestWatchRunContext[] = []
    let changed: (() => void) | undefined
    let listings = 0
    const watch = startJestWatch(
      config({
        watchPlugins: [{ path: join(dir, 'throws-on-change.cjs'), config: { throwAt: 0 } }],
      }),
      host(
        {
          // The first listing (at start) answers; the one a change asks for never does.
          listTests: () => (++listings === 1 ? Promise.resolve(change) : new Promise(() => {})),
          onFileChange: (listener) => {
            changed = listener
            return () => {}
          },
        },
        runs,
        { text: '' },
      ),
    )
    for (let i = 0; i < 20 && runs.length === 0; i += 1) await new Promise(setImmediate)
    changed?.()
    for (let i = 0; i < 20 && runs.length < 2; i += 1) await new Promise(setImmediate)
    assert.equal(listings, 2)
    assert.equal(runs.length, 2, 'the run did not wait for the listing')
    watch.dispose()
  })
})
