// One case through the real hoister and through ours, and everything compared. The test file says
// what is compared and why; this is how.
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { createPipeline, type HoistOutput, hoistMocks, toModuleRunner } from '@provino/transform'
import type { HoistPolicy, StaticMockCall, TransformRecord } from '@provino/types'
import { hoistMocks as hoistMockAndResolve } from '@vitest/mocker/node'
import { parseSync } from 'oxc-parser'
import { isRecord, prop } from '../internal/guards.ts'
import {
  chainRoot,
  child,
  childrenOf,
  formatOrder,
  type HoistOrder,
  isJestGetterCall,
  isNode,
  type Node,
  type OrderOptions,
  orderOf,
  sameOrder,
  specifierOf,
} from './order.ts'
import { type RunLog, type RunnerName, runRecorded } from './run-recorded.ts'

/** One input: a vendored upstream case, an authored one, or a generated layout. */
export interface HoistCase {
  readonly name: string
  readonly code: string
  readonly filename: string
  readonly jsx: 'automatic' | undefined
}

/**
 * What each real hoister moves and which modules are the runner, by runner. Fixed here from the
 * upstream sources, never read from the policy under test, or dropping a policy key would remove its
 * events from both sides of the comparison.
 */
const UPSTREAM: Readonly<
  Record<RunnerName, Pick<OrderOptions, 'hoistedNames' | 'runnerModules' | 'trackedNames'>>
> = {
  jest: {
    // babel-plugin-jest-hoist 30.5.0 `FUNCTIONS`.
    hoistedNames: new Set(['mock', 'unmock', 'deepUnmock', 'enableAutomock', 'disableAutomock']),
    runnerModules: new Set(['@jest/globals']),
    trackedNames: new Set(['doMock', 'dontMock', 'requireActual', 'hoisted']),
  },
  vitest: {
    // hoistMocks.ts `hoistableMockMethodNames` and `hoistedMethodNames`.
    hoistedNames: new Set(['mock', 'unmock', 'hoisted']),
    // `hoistedModule` and `REDISTRIBUTED_HOISTED_MODULES`.
    runnerModules: new Set(['vitest', 'vite-plus/test']),
    trackedNames: new Set(['doMock', 'doUnmock', 'importActual']),
  },
}

// ---------------------------------------------------------------------------------------------
// What a real hoister's error means

/** The stable text of each real error, and the code ours must report for it. */
const REAL_ERRORS: Readonly<Record<RunnerName, readonly (readonly [string, string])[]>> = {
  jest: [
    // babel-plugin-jest-hoist index.ts, the `buildCodeFrameError` texts.
    ['The module factory of `jest.mock()` is not allowed', 'HOIST_FACTORY_OUT_OF_SCOPE'],
    ['The second argument of `jest.mock` must be an inline function', 'HOIST_FACTORY_NOT_FUNCTION'],
  ],
  vitest: [
    // hoistMocks.ts `assertNotDefaultExport` and `assertNotNamedExport` calls.
    ['Cannot export the result of', 'HOIST_EXPORTED'],
    ['Cannot export hoisted variable', 'HOIST_EXPORTED'],
    // hoistMocks.ts `createError`.
    ['Cannot call ', 'HOIST_NESTED'],
    // hoistMocks.ts, the aggregated message.
    ["defined outside of the module's top level scope", 'HOIST_NOT_TOP_LEVEL'],
  ],
}

/** The `HOIST_*` code for a real hoister's message. A message it doesn't know fails the case. */
export function codeOfRealError(runner: RunnerName, message: string): string {
  for (const [text, code] of REAL_ERRORS[runner]) if (message.includes(text)) return code
  throw new Error(`no HOIST_* code for this ${runner} error: ${firstLine(message)}`)
}

// ---------------------------------------------------------------------------------------------
// What each hoister did with one input

/** A `StaticMockCall` without `loc`: no real hoister reports one. */
export type StaticMock = Omit<StaticMockCall, 'loc'>

export type Outcome =
  | { readonly kind: 'error'; readonly code: string; readonly message: string }
  | {
      readonly kind: 'ok'
      readonly order: HoistOrder
      readonly staticMocks: readonly StaticMock[]
      /**
       * The output after its hoister's real next step, ready to run. `undefined` only for a real
       * hoister whose output that step rejects (see `VITEST_OUTPUT_BROKEN`).
       */
      readonly runnable: string | undefined
    }

function messageOf(error: unknown): string {
  // Vitest throws a plain object (`name`, `message`, `frame`) rather than an `Error`.
  const message: unknown = isRecord(error) ? prop(error, 'message') : undefined
  return typeof message === 'string' ? message : String(error)
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? ''
}

const nodeRequire = createRequire(import.meta.url)

interface BabelCore {
  transformSync(
    code: string,
    options: Record<string, unknown>,
  ): { readonly code?: string | null } | null
}

/** A CommonJS package's main export, whichever way Babel's packages expose it. */
function defaultExport(loaded: unknown): unknown {
  return isRecord(loaded) ? prop(loaded, 'default') : loaded
}

function loadBabel(): {
  readonly core: BabelCore
  readonly plugin: unknown
  readonly presetReact: unknown
  readonly commonjs: unknown
} {
  const core: unknown = nodeRequire('@babel/core')
  if (
    typeof core !== 'object' ||
    core === null ||
    typeof Reflect.get(core, 'transformSync') !== 'function'
  ) {
    throw new Error('@babel/core has no transformSync')
  }
  return {
    core: core as BabelCore,
    plugin: defaultExport(nodeRequire('babel-plugin-jest-hoist')),
    presetReact: defaultExport(nodeRequire('@babel/preset-react')),
    commonjs: defaultExport(nodeRequire('@babel/plugin-transform-modules-commonjs')),
  }
}

const babel = loadBabel()

function babelOptions(upstream: HoistCase): Record<string, unknown> {
  return {
    babelrc: false,
    configFile: false,
    compact: false,
    filename: `/virtual/${upstream.filename}`,
    sourceType: 'module',
    ...(upstream.jsx === undefined
      ? {}
      : { presets: [[babel.presetReact, { development: true, runtime: upstream.jsx }]] }),
  }
}

/**
 * Babel's CommonJS step on the file: one pass with the plugin, because the plugin's `post` puts the
 * hoisted calls above the `require`s only when both run together. Types are stripped first, the way
 * the recorder's Jest transformer does it (`jest-transform.ts`): nothing can strip them after.
 */
function jestRunnable(upstream: HoistCase, record: TransformRecord): string {
  const isTypeScript = /\.[cm]?ts$/.test(upstream.filename)
  const code = isTypeScript ? stripTypeScriptTypes(upstream.code) : upstream.code
  const result = babel.core.transformSync(code, {
    ...babelOptions(upstream),
    parserOpts: { plugins: ['jsx'] },
    plugins: [babel.plugin, babel.commonjs],
  })
  if (typeof result?.code !== 'string') throw new Error('babel returned no CommonJS code')
  // Babel's CommonJS step leaves `import()` for the runtime. A `new Function` body would really
  // import it, so the module-runner form turns it into the stub's call. Nothing else in the code is
  // ESM by now, so nothing else changes.
  return moduleRunnerForm(upstream.filename, record, result.code)
}

/** The call rules of `FUNCTIONS` in babel-plugin-jest-hoist: which calls it really hoists. */
function jestCallHoists(method: string, args: readonly Node[]): boolean {
  if (method === 'mock') {
    if (args.length === 1) {
      const type = args[0]?.type
      return type === 'Literal' || type === 'TemplateLiteral'
    }
    return args.length === 2 || args.length === 3
  }
  return args.length === 1 && args[0]?.type === 'Literal' && typeof args[0].value === 'string'
}

const ORIGINAL_LOADER = /\b(?:import|require)(?:Actual|Original)\b/

/**
 * Jest has no real list of static mocks, so the list is read from the real output: each call on the
 * `_getJestObj()` the plugin wrote that passes its rule and names a module. Order isn't compared
 * here: the plugin's output is in hoisted order and `staticMocks` in source order (`orderOf` checks
 * the order).
 */
function staticMocksOfJestOutput(code: string): readonly StaticMock[] {
  const parsed = parseSync('hoisted.tsx', code, { sourceType: 'module' })
  const program: unknown = parsed.program
  const out: StaticMock[] = []
  const readCall = (call: Node): void => {
    const callee = child(call, 'callee')
    const property = callee?.type === 'MemberExpression' ? child(callee, 'property') : undefined
    const method = property?.type === 'Identifier' ? property.name : undefined
    const rawArgs = call.arguments
    const args = Array.isArray(rawArgs) ? rawArgs.filter(isNode) : []
    if (
      callee === undefined ||
      (method !== 'mock' && method !== 'unmock' && method !== 'deepUnmock') ||
      !isJestGetterCall(chainRoot(callee)) ||
      !jestCallHoists(method, args)
    ) {
      return
    }
    const specifier = specifierOf(args[0])
    if (specifier === undefined) return
    const factory = args[1]
    const isFactory =
      factory?.type === 'ArrowFunctionExpression' || factory?.type === 'FunctionExpression'
    const params = isFactory ? factory.params : undefined
    out.push({
      method,
      specifier,
      hasFactory: isFactory,
      automock: args.length === 1,
      factoryLoadsOriginal:
        isFactory &&
        ((Array.isArray(params) && params.length > 0) ||
          ORIGINAL_LOADER.test(
            code.slice(
              typeof factory.start === 'number' ? factory.start : 0,
              typeof factory.end === 'number' ? factory.end : 0,
            ),
          )),
    })
  }
  const visit = (node: Node): void => {
    // The plugin moves a statement only when its parent is a block (`getStatementParent`); in an
    // `if` with no block, a `case` or a label the call stays where it is, so it isn't hoisted.
    if (node.type === 'Program' || node.type === 'BlockStatement') {
      const body = node.body
      for (const statement of Array.isArray(body) ? body : []) {
        if (!isNode(statement) || statement.type !== 'ExpressionStatement') continue
        let at = child(statement, 'expression')
        while (at?.type === 'CallExpression') {
          readCall(at)
          const callee = child(at, 'callee')
          at = callee?.type === 'MemberExpression' ? child(callee, 'object') : undefined
        }
      }
    }
    for (const item of childrenOf(node)) visit(item)
  }
  if (isNode(program)) visit(program)
  return out
}

/**
 * Real Jest: the plugin on the file as written, with JSX lowered as upstream's own test does, so its
 * generated runtime import is in the output as it is in ours. Types stay in the output. The CJS
 * step is modelled in `orderOf`.
 */
function referenceJest(upstream: HoistCase, record: TransformRecord): Outcome {
  let output: string
  try {
    const result = babel.core.transformSync(upstream.code, {
      ...babelOptions(upstream),
      parserOpts: { plugins: ['jsx', 'typescript'] },
      plugins: [babel.plugin],
    })
    if (typeof result?.code !== 'string') throw new Error('babel returned no code')
    output = result.code
  } catch (error) {
    const message = messageOf(error)
    return { kind: 'error', code: codeOfRealError('jest', message), message }
  }
  return {
    kind: 'ok',
    order: orderOf(output, { ...UPSTREAM.jest, staticImports: 'after-hoisted', syntax: 'tsx' }),
    staticMocks: staticMocksOfJestOutput(output),
    runnable: jestRunnable(upstream, record),
  }
}

/**
 * The guard Vitest injects when `vi` isn't imported from `vitest`: it throws unless a global is
 * there, which is a question about the run's setup, not the hoisted order. B13c or T1.8 owns ours.
 */
const API_NOT_FOUND_GUARD = /\nif \(typeof globalThis\["[^\n]*\{ throw new Error\([^\n]*\) \}\n/

/**
 * Real Vitest: `hoistMockAndResolve` over an oxc AST. `undefined` means it left the file alone. What
 * it leaves static (`export * from`) really does load first: the module runner moves it above
 * `vi.mock`, measured on oxc's `moduleRunnerTransformSync`.
 */
function referenceVitest(upstream: HoistCase, record: TransformRecord): Outcome {
  const parse = (source: string): unknown =>
    parseSync('/test.js', source, { sourceType: 'module', preserveParens: false }).program
  const mocks: StaticMock[] = []
  let output: string
  try {
    const result = hoistMockAndResolve(record.code, '/test.js', parse as never, {
      root: '/',
      onStaticMock(mock) {
        // It also reports `doUnmock` and `importActual`, which load the original but never hoist;
        // `StaticMockCall` is the hoisted calls.
        if (mock.method === 'mock' || mock.method === 'unmock') {
          mocks.push({
            method: mock.method,
            specifier: mock.specifier,
            hasFactory: mock.hasFactory,
            automock: mock.automock === true,
            factoryLoadsOriginal: mock.factoryLoadsOriginal,
          })
        }
      },
    })
    output = result?.code ?? record.code
  } catch (error) {
    const message = messageOf(error)
    return { kind: 'error', code: codeOfRealError('vitest', message), message }
  }
  return {
    kind: 'ok',
    order: orderOf(output, { ...UPSTREAM.vitest, staticImports: 'first' }),
    staticMocks: mocks,
    runnable: vitestRunnable(upstream, record, output.replace(API_NOT_FOUND_GUARD, '\n')),
  }
}

/**
 * The Vitest cases (by name) whose real output isn't a program at all, each with what the
 * module-runner form says about it: `export { x }` left behind with the import gone, and
 * `import { vi } from "vitest"` injected into a file that declares `vi`. There's no run to compare
 * for these (the order and `staticMocks` still are). Any other case whose output fails the
 * module-runner form throws, and `hoist-corpus.test.ts` fails an entry whose output now runs.
 */
export const VITEST_OUTPUT_BROKEN: Readonly<Record<string, RegExp>> = {
  'object: a local named vi': /Identifier `vi` has already been declared/,
  'transform > named exports of imported binding': /Export '[^']+' is not defined/,
}

function vitestRunnable(
  upstream: HoistCase,
  record: TransformRecord,
  code: string,
): string | undefined {
  try {
    return moduleRunnerForm(upstream.filename, record, code)
  } catch (error) {
    if (VITEST_OUTPUT_BROKEN[upstream.name]?.test(messageOf(error)) === true) return undefined
    throw error
  }
}

function moduleRunnerForm(filename: string, record: TransformRecord, code: string): string {
  return toModuleRunner(filename, { ...record, code, map: null }).code
}

/** A hoister with `hoistMocks`' shape, so the tests can hand in a sabotaged one. */
export type Hoister = (
  code: string,
  policy: HoistPolicy,
  options: { readonly filename: string; readonly original: string },
) => HoistOutput

/** Ours: an error when it throws or reports an error diagnostic. A printed output must parse. */
function ours(
  hoist: Hoister,
  runner: RunnerName,
  record: TransformRecord,
  filename: string,
  original: string,
  policy: HoistPolicy,
): Outcome {
  let output: HoistOutput
  try {
    output = hoist(record.code, policy, { filename: `/virtual/${filename}`, original })
  } catch (error) {
    return { kind: 'error', code: 'THROWN', message: messageOf(error) }
  }
  const failure = output.diagnostics.find((diagnostic) => diagnostic.severity === 'error')
  if (failure !== undefined) {
    return { kind: 'error', code: failure.code, message: failure.message }
  }
  return {
    kind: 'ok',
    // Outside the `try`: code that doesn't parse fails the case, it doesn't count as an error.
    order: orderOf(output.code, { ...UPSTREAM[runner], staticImports: 'first' }),
    staticMocks: output.staticMocks.map(({ loc: _loc, ...rest }) => rest),
    runnable: moduleRunnerForm(filename, record, output.code),
  }
}

// ---------------------------------------------------------------------------------------------
// The comparison

function formatMock(mock: StaticMock): string {
  return `${mock.method}(${mock.specifier}) factory=${mock.hasFactory} automock=${mock.automock} original=${mock.factoryLoadsOriginal}`
}

function staticMocksDiffer(
  runner: RunnerName,
  reference: readonly StaticMock[],
  got: readonly StaticMock[],
): string | undefined {
  const lines = (mocks: readonly StaticMock[]): string[] => {
    const formatted = mocks.map(formatMock)
    return runner === 'jest' ? formatted.toSorted() : formatted
  }
  const real = lines(reference)
  const mine = lines(got)
  if (real.join('\n') === mine.join('\n')) return undefined
  return `staticMocks differ\nreal:\n${real.join('\n')}\nours:\n${mine.join('\n')}`
}

function logsDiffer(
  reference: RunLog,
  got: RunLog,
  ignore: RegExp | undefined,
): string | undefined {
  if (got.compileError !== undefined)
    return `run log differs: ours does not compile: ${got.compileError}`
  const kept = (line: string): boolean => ignore === undefined || !ignore.test(line)
  const real = reference.lines.filter(kept)
  const mine = got.lines.filter(kept)
  const length = Math.max(real.length, mine.length)
  for (let line = 0; line < length; line++) {
    if (real[line] !== mine[line]) {
      const from = Math.max(0, line - 2)
      return [
        `run log differs at line ${line}`,
        `real: ${real.slice(from, line + 3).join(' | ')}`,
        `ours: ${mine.slice(from, line + 3).join(' | ')}`,
      ].join('\n')
    }
  }
  return undefined
}

/** A run of the real hoister's output that can't be compared is a broken check, not a difference. */
function assertRealRan(runner: RunnerName, upstream: HoistCase, log: RunLog): void {
  if (log.compileError !== undefined) {
    throw new Error(
      `the real ${runner} output for "${upstream.name}" doesn't compile: ${log.compileError}`,
    )
  }
  if (log.truncated) throw new Error(`the real ${runner} run of "${upstream.name}" never ended`)
}

// ---------------------------------------------------------------------------------------------
// Running a case

const pipelines = new Map<string, ReturnType<typeof createPipeline>>()

/** The pipeline's output for the case: what both hoisters are given. */
function stripped(upstream: HoistCase): TransformRecord {
  const key = upstream.jsx ?? 'plain'
  let pipeline = pipelines.get(key)
  if (pipeline === undefined) {
    pipeline = createPipeline({
      root: '/virtual',
      typescript: 'oxc',
      tsconfig: false,
      hoist: null,
      cache: false,
      ...(upstream.jsx === undefined ? {} : { jsx: { runtime: upstream.jsx, development: true } }),
    })
    pipelines.set(key, pipeline)
  }
  const record = pipeline.transform({
    filename: `/virtual/${upstream.filename}`,
    source: upstream.code,
    role: 'test',
    consumer: 'import',
    instrument: false,
  })
  const failure = record.diagnostics.find((diagnostic) => diagnostic.severity === 'error')
  if (failure !== undefined) {
    throw new Error(`the pipeline can't read "${upstream.name}": ${failure.message}`)
  }
  return record
}

export interface CaseOptions {
  readonly hoist?: Hoister
  /** The policy ours runs under. The real hoisters never see one. */
  readonly policy: HoistPolicy
  /** Log lines left out on both sides, for a known defect in the real hoister (named by the caller). */
  readonly ignoreLog?: RegExp
}

/** What the real hoister did with the case. */
export function referenceOutcome(
  runner: RunnerName,
  upstream: HoistCase,
  record: TransformRecord = stripped(upstream),
): Outcome {
  return runner === 'jest' ? referenceJest(upstream, record) : referenceVitest(upstream, record)
}

/** What differs between the real hoister and ours, or `undefined` when they agree. */
export async function problem(
  runner: RunnerName,
  upstream: HoistCase,
  options: CaseOptions,
): Promise<string | undefined> {
  const record = stripped(upstream)
  const reference = referenceOutcome(runner, upstream, record)
  const got = ours(
    options.hoist ?? hoistMocks,
    runner,
    record,
    upstream.filename,
    upstream.code,
    options.policy,
  )
  if (reference.kind === 'error' && got.kind === 'error') {
    if (reference.code === got.code) return undefined
    return `error code differs: the real hoister means ${reference.code} (${firstLine(reference.message)}), ours reports ${got.code} (${firstLine(got.message)})`
  }
  if (reference.kind === 'error') {
    return `error code differs: the real hoister throws ${reference.code} (${firstLine(reference.message)}) and ours does not`
  }
  if (got.kind === 'error') {
    return `error code differs: ours reports ${got.code} (${firstLine(got.message)}) and the real hoister does not`
  }
  if (!sameOrder(reference.order, got.order)) {
    return `hoisted order differs\nreal:\n${formatOrder(reference.order)}\nours:\n${formatOrder(got.order)}`
  }
  const mocks = staticMocksDiffer(runner, reference.staticMocks, got.staticMocks)
  if (mocks !== undefined) return mocks
  if (got.runnable === undefined) throw new Error('ours always has a next step')
  const ourLog = await runRecorded(got.runnable, runner)
  if (reference.runnable === undefined) {
    return ourLog.compileError === undefined
      ? undefined
      : `run log differs: ours does not compile: ${ourLog.compileError}`
  }
  const realLog = await runRecorded(reference.runnable, runner)
  assertRealRan(runner, upstream, realLog)
  return logsDiffer(realLog, ourLog, options.ignoreLog)
}

/** Ours alone, run: for what the real hoisters can't be compared on. */
export async function runOurs(
  runner: RunnerName,
  upstream: HoistCase,
  policy: HoistPolicy,
): Promise<RunLog> {
  const record = stripped(upstream)
  const got = ours(hoistMocks, runner, record, upstream.filename, upstream.code, policy)
  if (got.kind === 'error') throw new Error(`ours reports ${got.code} on "${upstream.name}"`)
  if (got.runnable === undefined) throw new Error('ours always has a next step')
  return runRecorded(got.runnable, runner)
}

/** Plain JavaScript in a `.js` file: most authored cases. */
export function plainCase(name: string, code: string, filename = 'file.js'): HoistCase {
  return { name, code, filename, jsx: undefined }
}
