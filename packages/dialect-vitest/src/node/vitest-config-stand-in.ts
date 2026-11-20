// B25c, T11.15, open question 1 (a): what `import { defineConfig } from 'vitest/config'` gives a config
// the reader loads, so reading one needs neither Vitest nor Vite. The data is copied from
// `vitest/config` 5.0.5 (`defaults.ts`) and held to the real values by `defaults.test.ts`; the
// defaults that follow the environment (`allowOnly`, `watch`, `open`, `reporters`) follow it the
// way Vitest's do (CI, a terminal, an agent) and aren't compared. `mergeConfig` is Vite's, rebuilt
// in `vite-merge.ts`.
import { availableParallelism } from 'node:os'
import { mergeConfig } from './vite-merge.ts'

type Rec = Record<string, unknown>

/**
 * Vitest's `defaultInclude`.
 * @public
 */
export const defaultInclude: string[] = ['**/*.{test,spec}.?(c|m)[jt]s?(x)']

/**
 * Vitest's `defaultExclude`.
 * @public
 */
export const defaultExclude: string[] = ['**/node_modules/**', '**/.git/**']

const isCI = Boolean(process.env.CI) && process.env.CI !== 'false'

/**
 * Vitest's `coverageConfigDefaults`.
 * @public
 */
export const coverageConfigDefaults: Readonly<Rec> = {
  provider: 'v8',
  enabled: false,
  clean: true,
  cleanOnRerun: true,
  reportsDirectory: './coverage',
  exclude: [],
  reportOnFailure: false,
  reporter: ['text', 'html', 'clover', 'json'],
  allowExternal: false,
  excludeAfterRemap: false,
  processingConcurrency: Math.min(20, availableParallelism()),
  ignoreClassMethods: [],
  skipFull: false,
  watermarks: {
    statements: [50, 80],
    functions: [50, 80],
    branches: [50, 80],
    lines: [50, 80],
  },
  autoAttachSubprocess: false,
}

/**
 * Vitest's `configDefaults`. `watch` is `false` (the reader never runs watch mode) and `open` and
 * `reporters` are the values a non-interactive run has.
 * @public
 */
export const configDefaults: Readonly<Rec> = Object.freeze({
  allowOnly: !isCI,
  isolate: true,
  watch: false,
  globals: false,
  injectCjsGlobals: true,
  environment: 'node',
  clearMocks: true,
  restoreMocks: false,
  mockReset: false,
  unstubGlobals: false,
  unstubEnvs: false,
  include: defaultInclude,
  exclude: defaultExclude,
  teardownTimeout: 10000,
  forceRerunTriggers: ['**/package.json', '**/{vitest,vite}.config.*'],
  update: false,
  reporters: ['default'],
  silent: false,
  hideSkippedTests: false,
  api: false,
  ui: false,
  uiBase: '/__vitest__/',
  open: false,
  css: { include: [] },
  coverage: coverageConfigDefaults,
  fakeTimers: { loopLimit: 10_000, shouldClearNativeTimers: true },
  maxConcurrency: 5,
  dangerouslyIgnoreUnhandledErrors: false,
  typecheck: {
    checker: 'tsc',
    include: ['**/*.{test,spec}-d.?(c|m)[jt]s?(x)'],
    exclude: defaultExclude,
  },
  slowTestThreshold: 300,
  taskTitleValueFormatTruncate: 40,
  disableConsoleIntercept: false,
  detectAsyncLeaks: false,
})

/**
 * `defineConfig` of `vitest/config`: the identity, for types.
 * @public
 */
export function defineConfig<T>(config: T): T {
  return config
}

/**
 * `defineProject` of `vitest/config`: the identity, for types.
 * @public
 */
export function defineProject<T>(config: T): T {
  return config
}

/**
 * What a config that imports `vitest/config` is given.
 * @public
 */
export interface VitestConfigStandIn {
  readonly defineConfig: typeof defineConfig
  readonly defineProject: typeof defineProject
  readonly mergeConfig: typeof mergeConfig
  readonly configDefaults: typeof configDefaults
  readonly coverageConfigDefaults: typeof coverageConfigDefaults
  readonly defaultExclude: typeof defaultExclude
  readonly defaultInclude: typeof defaultInclude
}

/**
 * The stand-in's members, in the order its served module exports them.
 * @public
 */
export const vitestConfigStandIn: VitestConfigStandIn = {
  defineConfig,
  defineProject,
  mergeConfig,
  configDefaults,
  coverageConfigDefaults,
  defaultExclude,
  defaultInclude,
}

export { mergeConfig }
