// B13b's hoist check (T3.4): our `hoistMocks` against the real, pinned hoisters on every upstream
// case. Jest's is `babel-plugin-jest-hoist` 30.5.0 through `@babel/core`; Vitest's is
// `hoistMocks` from `@vitest/mocker` 5.0.5, parsed with oxc. The inputs are in `vendor/*.json`
// (`pnpm hoist:extract` copies them from the pinned `.refs/` clones, which CI doesn't have).
//
// Each real hoister reads what it reads in a real run. Jest's plugin sees the file as written,
// because Babel hoists before it lowers JSX or TypeScript: types through a parser plugin, and JSX
// through `@babel/preset-react`, as upstream's own test runs it. Vitest's plugin sees the
// transform's output, as ours does, and ours also gets the original source, so a name the transform
// generated (`_jsxDEV`) never counts as out of scope.
//
// What is compared is what build-plan §1 T3.4 asks for: error or no error, and the hoisted order
// (`hoist-corpus/order.ts`). Exact output, messages and Vitest's injected `API_NOT_FOUND` guard
// are not compared.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { jestHoistPolicy } from '@provino/dialect-jest'
import { createPipeline, type HoistOutput, hoistMocks } from '@provino/transform'
import type { HoistPolicy } from '@provino/types'
import { hoistMocks as hoistMockAndResolve } from '@vitest/mocker/node'
import { parseSync } from 'oxc-parser'
import {
  formatOrder,
  type HoistOrder,
  type OrderOptions,
  orderOf,
  sameOrder,
} from './hoist-corpus/order.ts'
import { vitestHoistPolicy } from './mock-corpus/profiles.ts'

/** The pinned case counts: a shrinking (or growing) extraction fails until someone says why. */
const EXPECTED_COUNTS = { jest: 12, vitest: 96 } as const

/**
 * Cases skipped, by `<runner>: <name>`, each with the reason. A case belongs here only if it is
 * truly outside `HoistPolicy`. Empty today, and it should stay that way.
 */
const SKIPPED: Readonly<Record<string, string>> = {}

interface UpstreamCase {
  readonly name: string
  readonly code: string
  readonly filename: string
  readonly jsx: 'automatic' | undefined
}

function readCases(file: string): readonly UpstreamCase[] {
  const parsed: unknown = JSON.parse(
    readFileSync(fileURLToPath(new URL(`hoist-corpus/vendor/${file}`, import.meta.url)), 'utf8'),
  )
  const cases: unknown =
    typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'cases') : null
  if (!Array.isArray(cases)) throw new Error(`${file}: no cases array`)
  return cases.map((entry: unknown, index): UpstreamCase => {
    const field = (key: string): unknown =>
      typeof entry === 'object' && entry !== null ? Reflect.get(entry, key) : undefined
    const name = field('name')
    const code = field('code')
    const filename = field('filename')
    const jsx = field('jsx')
    if (typeof name !== 'string' || typeof code !== 'string') {
      throw new Error(`${file}: case ${index} has no name or code`)
    }
    return {
      name,
      code,
      filename: typeof filename === 'string' ? filename : 'test.js',
      jsx: jsx === 'automatic' ? 'automatic' : undefined,
    }
  })
}

const JEST_CASES = readCases('jest.json')
const VITEST_CASES = readCases('vitest.json')

// ---------------------------------------------------------------------------------------------
// What each hoister did with one input

type Outcome =
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ok'; readonly order: HoistOrder }

function messageOf(error: unknown): string {
  // Vitest throws a plain object (`name`, `message`, `frame`) rather than an `Error`.
  const message: unknown =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'message') : undefined
  return typeof message === 'string' ? message : String(error)
}

function orderOptions(
  policy: HoistPolicy,
  staticImports: OrderOptions['staticImports'],
): OrderOptions {
  return {
    hoistedNames: new Set([...Object.keys(policy.hoistCalls), ...policy.hoistValues]),
    runnerModules: new Set(policy.runnerModules),
    staticImports,
  }
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
  return typeof loaded === 'object' && loaded !== null ? Reflect.get(loaded, 'default') : loaded
}

function babel(): {
  readonly core: BabelCore
  readonly plugin: unknown
  readonly presetReact: unknown
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
  }
}

/**
 * Real Jest: the plugin on the file as written, with JSX lowered as upstream's own test does, so its
 * generated runtime import is in the output as it is in ours. Types stay in the output. The CJS
 * step is modelled in `orderOf`.
 */
function referenceJest(upstream: UpstreamCase, policy: HoistPolicy): Outcome {
  const { core, plugin, presetReact } = babel()
  try {
    const result = core.transformSync(upstream.code, {
      babelrc: false,
      configFile: false,
      filename: '/virtual/file.js',
      sourceType: 'module',
      parserOpts: { plugins: ['jsx', 'typescript'] },
      plugins: [plugin],
      ...(upstream.jsx === undefined
        ? {}
        : { presets: [[presetReact, { development: true, runtime: upstream.jsx }]] }),
    })
    const output = result?.code
    if (typeof output !== 'string') return { kind: 'error', message: 'babel returned no code' }
    return {
      kind: 'ok',
      order: orderOf(output, { ...orderOptions(policy, 'after-hoisted'), syntax: 'tsx' }),
    }
  } catch (error) {
    return { kind: 'error', message: messageOf(error) }
  }
}

/**
 * Real Vitest: `hoistMockAndResolve` over an oxc AST. `undefined` means it left the file alone. What
 * it leaves static (`export * from`) really does load first: the module runner moves it above
 * `vi.mock`, measured on oxc's `moduleRunnerTransformSync`.
 */
function referenceVitest(code: string, policy: HoistPolicy): Outcome {
  const parse = (source: string): unknown =>
    parseSync('/test.js', source, { sourceType: 'module', preserveParens: false }).program
  try {
    const result = hoistMockAndResolve(code, '/test.js', parse as never, { root: '/' })
    return {
      kind: 'ok',
      order: orderOf(result?.code ?? code, orderOptions(policy, 'first')),
    }
  } catch (error) {
    return { kind: 'error', message: messageOf(error) }
  }
}

type Hoister = (
  code: string,
  policy: HoistPolicy,
  options: { readonly filename: string; readonly original: string },
) => HoistOutput

/** Ours: error when it throws or reports an error diagnostic; otherwise the order it printed. */
function ours(hoist: Hoister, code: string, original: string, policy: HoistPolicy): Outcome {
  try {
    const output = hoist(code, policy, { filename: '/virtual/file.js', original })
    const failure = output.diagnostics.find((diagnostic) => diagnostic.severity === 'error')
    if (failure !== undefined) return { kind: 'error', message: failure.message }
    return { kind: 'ok', order: orderOf(output.code, orderOptions(policy, 'first')) }
  } catch (error) {
    return { kind: 'error', message: messageOf(error) }
  }
}

/** What differs between the real hoister and ours, or `undefined` when they agree. */
function difference(reference: Outcome, got: Outcome): string | undefined {
  if (reference.kind === 'error' && got.kind === 'error') return undefined
  if (reference.kind === 'error') {
    return `the real hoister throws (${firstLine(reference.message)}) and ours does not`
  }
  if (got.kind === 'error') {
    return `ours throws (${firstLine(got.message)}) and the real hoister does not`
  }
  if (sameOrder(reference.order, got.order)) return undefined
  return `hoisted order differs\nreal:\n${formatOrder(reference.order)}\nours:\n${formatOrder(got.order)}`
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? ''
}

// ---------------------------------------------------------------------------------------------
// Running a case

const pipelines = new Map<string, ReturnType<typeof createPipeline>>()

/** The pipeline's output for the case: what both hoisters are given. */
function stripped(upstream: UpstreamCase): string {
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
  if (failure !== undefined)
    throw new Error(`the pipeline can't read "${upstream.name}": ${failure.message}`)
  return record.code
}

type Runner = 'jest' | 'vitest'
const POLICIES: Readonly<Record<Runner, HoistPolicy>> = {
  jest: jestHoistPolicy,
  vitest: vitestHoistPolicy,
}

function problem(runner: Runner, upstream: UpstreamCase, hoist: Hoister): string | undefined {
  const policy = POLICIES[runner]
  const code = stripped(upstream)
  const reference =
    runner === 'jest' ? referenceJest(upstream, policy) : referenceVitest(code, policy)
  return difference(reference, ours(hoist, code, upstream.code, policy))
}

// ---------------------------------------------------------------------------------------------
// The tests

test('the extracted case counts are pinned', () => {
  assert.equal(JEST_CASES.length, EXPECTED_COUNTS.jest)
  assert.equal(VITEST_CASES.length, EXPECTED_COUNTS.vitest)
  for (const [runner, cases] of [
    ['jest', JEST_CASES],
    ['vitest', VITEST_CASES],
  ] as const) {
    assert.equal(
      new Set(cases.map((c) => c.name)).size,
      cases.length,
      `${runner}: case names repeat`,
    )
  }
})

test('every skip names a case that exists and gives a reason', () => {
  const all = new Set([
    ...JEST_CASES.map((c) => `jest: ${c.name}`),
    ...VITEST_CASES.map((c) => `vitest: ${c.name}`),
  ])
  for (const [key, reason] of Object.entries(SKIPPED)) {
    assert.ok(all.has(key), `skip "${key}" matches no case`)
    assert.ok(reason.trim().length > 0, `skip "${key}" needs a reason`)
  }
})

for (const [runner, cases] of [
  ['jest', JEST_CASES],
  ['vitest', VITEST_CASES],
] as const) {
  for (const upstream of cases) {
    const key = `${runner}: ${upstream.name}`
    const reason = SKIPPED[key]
    test(key, { skip: reason ?? false }, () => {
      const found = problem(runner, upstream, hoistMocks)
      assert.equal(found, undefined, found)
    })
  }
}

test('the check is not vacuous: an engine that moves nothing disagrees with the real hoisters', () => {
  // `identity` hoists nothing and rewrites nothing. If the comparison could be passed by
  // normalizing everything away, it would agree with the real hoisters here too.
  const identity: Hoister = (code) => ({
    code,
    map: null,
    staticMocks: [],
    diagnostics: [],
    rewroteImports: false,
  })
  // Measured with `identity`: Jest has 3 cases that tell it apart (the mock below a `require`, two
  // calls above a `require`, and a factory the pipeline's JSX output makes out of scope); Vitest has
  // about 70 (every import to rewrite, every violation to throw).
  const atLeast = { jest: 3, vitest: 50 } as const
  for (const [runner, cases] of [
    ['jest', JEST_CASES],
    ['vitest', VITEST_CASES],
  ] as const) {
    const disagreements = cases.filter(
      (upstream) =>
        !(`${runner}: ${upstream.name}` in SKIPPED) &&
        problem(runner, upstream, identity) !== undefined,
    )
    assert.ok(
      disagreements.length >= atLeast[runner],
      `${runner}: only ${disagreements.length} cases disagree`,
    )
  }
})
