// B13b's hoist check (T3.4): our `hoistMocks` against the real, pinned hoisters. Jest's is
// `babel-plugin-jest-hoist` 30.5.0 through `@babel/core`; Vitest's is `hoistMocks` from
// `@vitest/mocker` 5.0.5, parsed with oxc. T3.4's acceptance is this check (non-negotiable 6), so it
// has to fail on a wrong engine, and the tests at the bottom show it does.
//
// The inputs:
// - `vendor/*.json`: every upstream case (`pnpm hoist:extract` copies them from the pinned `.refs/`
//   clones, which CI doesn't have).
// - `hoist-corpus/inputs.ts`: Provino's own, so every policy key has inputs a flip of it fails.
// - `hoist-corpus/generate.ts`: seeded statement layouts, for the orderings nobody thought of.
//
// Each real hoister reads what it reads in a real run. Jest's plugin sees the file as written,
// because Babel hoists before it lowers JSX or TypeScript. Vitest's plugin sees the transform's
// output, as ours does, and ours also gets the original source, so a name the transform generated
// (`_jsxDEV`) never counts as out of scope.
//
// What is compared on every case, in this order (`hoist-corpus/check.ts`):
// 1. The error. Each real message maps to a `HOIST_*` code, and the codes must match: two different
//    errors don't agree. A real message with no mapping fails the case.
// 2. The hoisted order (`hoist-corpus/order.ts`): the calls, loads and consts a hoisted call reads, by
//    block. Ours is read outside the `try`, so output that doesn't parse fails rather than "errors".
// 3. `staticMocks`, against `onStaticMock` under Vitest. Jest has no real list, so its expected list
//    is read from the hoisted calls in the real output.
// 4. A run (`hoist-corpus/run-recorded.ts`). `orderOf` can't see a lost binding, so each output goes
//    through its real next step (Babel's CommonJS plugin for Jest, the module-runner form for ours
//    and for Vitest) and runs against recording stubs. The logs must match: mock calls and their
//    arguments, module loads, property reads, `this`, exported values (read twice, so a frozen export
//    shows), factories (run at the load that needs them, so a TDZ shows) and callbacks.
//
// Not compared: the exact output, the messages' text, `loc`, and Vitest's injected `API_NOT_FOUND`
// guard. An allowance is named per case: `SKIPPED`, `REAL_HOISTER_QUIRKS`, and `VITEST_OUTPUT_BROKEN`
// in `check.ts`, where real Vitest's output isn't a program, so only the run is left out. Each has
// a test that fails when the allowance is no longer needed.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { jestHoistPolicy } from '@provino/dialect-jest'
import { hoistMocks } from '@provino/transform'
import type { HoistPolicy } from '@provino/types'
import {
  codeOfRealError,
  type HoistCase,
  type Hoister,
  plainCase,
  problem,
  referenceOutcome,
  runOurs,
  VITEST_OUTPUT_BROKEN,
} from './hoist-corpus/check.ts'
import { FLIPS, UNPROVABLE } from './hoist-corpus/flips.ts'
import { generateLayouts } from './hoist-corpus/generate.ts'
import { JEST_INPUTS, VITEST_INPUTS } from './hoist-corpus/inputs.ts'
import type { RunnerName } from './hoist-corpus/run-recorded.ts'
import { isRecord, prop } from './internal/guards.ts'
import { vitestHoistPolicy } from './mock-corpus/profiles.ts'

/** The pinned case counts: a shrinking (or growing) corpus fails until someone says why. */
const EXPECTED_COUNTS = {
  vendored: { jest: 12, vitest: 96 },
  authored: { jest: 189, vitest: 116 },
  generated: { jest: 3000, vitest: 3000 },
} as const

/** Fixed, so a failure names a case that reproduces. */
const SEEDS = { jest: 20261106, vitest: 20261107 } as const

/**
 * Cases skipped, by `<runner>: <name>`, each with the reason. A case belongs here only if it is
 * truly outside `HoistPolicy`.
 */
const SKIPPED: Readonly<Record<string, string>> = {
  'vitest: object: a comment before the call parens':
    "Vitest's `regexpHoistable` needs `(` right after the name, so this file skips its hoister and the mock never applies. That is its prefilter's blind spot, which no policy key describes; ours hoists it (D7).",
}

/**
 * Log lines left out of one case's comparison, each for a named defect or quirk in the real hoister.
 * Every other part of the case (error, order, `staticMocks`, the rest of the log) is still compared.
 */
const REAL_HOISTER_QUIRKS: Readonly<
  Record<string, { readonly reason: string; readonly ignoreLog: RegExp }>
> = {
  'jest: const: an exported const moves': {
    reason:
      'The plugin moves the declaration out of `export const a = 1` after Babel has noted the export, so `exports.a` stays `undefined`. Ours exports 1 (D7).',
    ignoreLog: /^export (?:first|live) a = /,
  },
  'jest: const: an exported const stays exported': {
    reason: 'The same `export const` defect as "an exported const moves".',
    ignoreLog: /^export (?:first|live) a = /,
  },
  'vitest: transform > should declare variable for imported super class #2': {
    reason:
      "For a class declaration Vitest copies an imported superclass into a `const` once (`info.classDeclaration`); ours reads it at each `extends`. The class definition is the only reader, so it's the same value.",
    ignoreLog: /^read \.\/dependency\.Foo$/,
  },
}

function readCases(file: string): readonly HoistCase[] {
  const parsed: unknown = JSON.parse(
    readFileSync(fileURLToPath(new URL(`hoist-corpus/vendor/${file}`, import.meta.url)), 'utf8'),
  )
  const cases: unknown = isRecord(parsed) ? prop(parsed, 'cases') : null
  if (!Array.isArray(cases)) throw new Error(`${file}: no cases array`)
  return cases.map((entry: unknown, index): HoistCase => {
    const field = (key: string): unknown => (isRecord(entry) ? prop(entry, key) : undefined)
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

const VENDORED: Readonly<Record<RunnerName, readonly HoistCase[]>> = {
  jest: readCases('jest.json'),
  vitest: readCases('vitest.json'),
}
const AUTHORED: Readonly<Record<RunnerName, readonly HoistCase[]>> = {
  jest: JEST_INPUTS,
  vitest: VITEST_INPUTS,
}
const POLICIES: Readonly<Record<RunnerName, HoistPolicy>> = {
  jest: jestHoistPolicy,
  vitest: vitestHoistPolicy,
}
const RUNNERS = ['jest', 'vitest'] as const

function namedCases(runner: RunnerName): readonly HoistCase[] {
  return [...VENDORED[runner], ...AUTHORED[runner]]
}

function caseNamed(runner: RunnerName, name: string): HoistCase {
  const found = namedCases(runner).find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`${runner}: no case named "${name}"`)
  return found
}

function isSkipped(runner: RunnerName, name: string): boolean {
  return `${runner}: ${name}` in SKIPPED
}

// ---------------------------------------------------------------------------------------------
// The corpus

test('the case counts are pinned and the names are unique', () => {
  const generated = {
    jest: generateLayouts('jest', EXPECTED_COUNTS.generated.jest, SEEDS.jest),
    vitest: generateLayouts('vitest', EXPECTED_COUNTS.generated.vitest, SEEDS.vitest),
  }
  for (const runner of RUNNERS) {
    assert.equal(VENDORED[runner].length, EXPECTED_COUNTS.vendored[runner])
    assert.equal(AUTHORED[runner].length, EXPECTED_COUNTS.authored[runner])
    assert.equal(generated[runner].length, EXPECTED_COUNTS.generated[runner])
    assert.equal(
      new Set(namedCases(runner).map((c) => c.name)).size,
      namedCases(runner).length,
      `${runner}: case names repeat`,
    )
  }
})

test('every skip names a case that exists and gives a reason', () => {
  const all = new Set(
    RUNNERS.flatMap((runner) => namedCases(runner).map((c) => `${runner}: ${c.name}`)),
  )
  for (const [key, reason] of Object.entries(SKIPPED)) {
    assert.ok(all.has(key), `skip "${key}" matches no case`)
    assert.ok(reason.trim().length > 0, `skip "${key}" needs a reason`)
  }
  for (const [key, { reason }] of Object.entries(REAL_HOISTER_QUIRKS)) {
    assert.ok(all.has(key), `quirk "${key}" matches no case`)
    assert.ok(reason.trim().length > 0, `quirk "${key}" needs a reason`)
  }
})

/** A `<runner>: <name>` key of `SKIPPED` or `REAL_HOISTER_QUIRKS`, as the runner and the name. */
function splitKey(key: string): readonly [RunnerName, string] {
  return key.startsWith('jest: ')
    ? ['jest', key.slice('jest: '.length)]
    : ['vitest', key.slice('vitest: '.length)]
}

for (const key of Object.keys(SKIPPED)) {
  test(`the skip on "${key}" is still needed: the case differs without it`, async () => {
    const [runner, name] = splitKey(key)
    const found = await problem(runner, caseNamed(runner, name), { policy: POLICIES[runner] })
    assert.ok(found !== undefined, `${key} agrees now: remove its entry`)
  })
}

for (const name of Object.keys(VITEST_OUTPUT_BROKEN)) {
  test(`real Vitest's output for "${name}" is still not a program`, () => {
    const outcome = referenceOutcome('vitest', caseNamed('vitest', name))
    assert.equal(outcome.kind, 'ok', `${name}: real Vitest reports an error now`)
    assert.equal(
      outcome.kind === 'ok' ? outcome.runnable : undefined,
      undefined,
      `${name} runs now: remove its VITEST_OUTPUT_BROKEN entry`,
    )
  })
}

for (const [key, { ignoreLog }] of Object.entries(REAL_HOISTER_QUIRKS)) {
  test(`the quirk on "${key}" is still there: the log differs without the allowance`, async () => {
    const [runner, name] = splitKey(key)
    const upstream = caseNamed(runner, name)
    assert.equal(
      await problem(runner, upstream, { policy: POLICIES[runner], ignoreLog }),
      undefined,
    )
    const without = await problem(runner, upstream, { policy: POLICIES[runner] })
    assert.ok(without !== undefined, `${key} agrees now: remove its entry`)
    assert.match(without, /^run log differs/)
  })
}

for (const runner of RUNNERS) {
  for (const upstream of namedCases(runner)) {
    const key = `${runner}: ${upstream.name}`
    test(key, { skip: SKIPPED[key] ?? false }, async () => {
      const ignoreLog = REAL_HOISTER_QUIRKS[key]?.ignoreLog
      const found = await problem(runner, upstream, {
        policy: POLICIES[runner],
        ...(ignoreLog === undefined ? {} : { ignoreLog }),
      })
      assert.equal(found, undefined, found)
    })
  }

  test(`${runner}: every generated layout agrees`, async () => {
    const layouts = generateLayouts(runner, EXPECTED_COUNTS.generated[runner], SEEDS[runner])
    const failures: string[] = []
    for (const layout of layouts) {
      const found = await problem(runner, layout, { policy: POLICIES[runner] })
      if (found !== undefined)
        failures.push(`${layout.name}\n${JSON.stringify(layout.code)}\n${found}`)
    }
    assert.equal(
      failures.length,
      0,
      `${failures.length} of ${layouts.length} disagree. The first three:\n${failures.slice(0, 3).join('\n\n')}`,
    )
  })
}

// ---------------------------------------------------------------------------------------------
// What the differential can't say

test('import attributes survive: ours keeps them, though neither real next step does', async () => {
  // Babel's CJS step and Vitest's `import(${sourceString})` both drop them, so comparing with those
  // would prove nothing. A JSON import without its attribute fails at runtime, so ours keeps them.
  const expected = './j.json {"with":{"type":"json"}}'
  for (const runner of RUNNERS) {
    const log = await runOurs(
      runner,
      caseNamed(runner, 'import: an import attribute'),
      POLICIES[runner],
    )
    assert.deepEqual(log.loadOptions, [expected])
  }
})

test('`export { x }` of an import under Vitest: real output has no next step, ours stays live', async () => {
  // Vitest removes the import and leaves `export { x }`, so the module-runner form rejects its
  // output ("Export 'x' is not defined"). There is nothing to compare, so the export is checked
  // directly: it must read through to the mocked module, and move when the module's binding does.
  const inputs = [
    ['import { a } from "./x"\nvi.mock("./x")\nexport { a }\n', 'a', './x.a'],
    ['import { a } from "./x"\nvi.mock("./x")\nexport { a as b }\n', 'b', './x.a'],
    ['import { a } from "./x"\nvi.mock("./x")\nexport { a as default }\n', 'default', './x.a'],
  ] as const
  for (const [code, exported, value] of inputs) {
    const log = await runOurs('vitest', plainCase(code, code), POLICIES.vitest)
    assert.ok(
      log.lines.includes(`export first ${exported} = <${value}>`),
      `${code}\n${log.lines.join('\n')}`,
    )
    assert.ok(
      log.lines.includes(`export live ${exported} = <${value}@2>`),
      `${code}\n${log.lines.join('\n')}`,
    )
  }
})

test('a real error with no HOIST_* code fails rather than counting as any error', () => {
  assert.equal(
    codeOfRealError('jest', 'The module factory of `jest.mock()` is not allowed to'),
    'HOIST_FACTORY_OUT_OF_SCOPE',
  )
  assert.throws(() => codeOfRealError('vitest', 'Cannot read properties of undefined'), /no HOIST_/)
})

// ---------------------------------------------------------------------------------------------
// Not vacuous: a wrong engine fails

const passThrough = (code: string): ReturnType<Hoister> => ({
  code,
  map: null,
  staticMocks: [],
  diagnostics: [],
  rewroteImports: false,
  lateDeps: [],
})

/**
 * The `identity` counts for `namedCases`, measured on 201 Jest and 212 Vitest cases. They read no
 * engine, so they change only when the inputs or the comparison do.
 */
const IDENTITY_DISAGREEMENTS = { jest: 163, vitest: 194 } as const

async function countDisagreements(runner: RunnerName, hoist: Hoister): Promise<number> {
  let count = 0
  for (const upstream of namedCases(runner)) {
    if (isSkipped(runner, upstream.name)) continue
    if ((await problem(runner, upstream, { hoist, policy: POLICIES[runner] })) !== undefined) {
      count++
    }
  }
  return count
}

test('an engine that moves nothing disagrees with the real hoisters on exactly these many cases', async () => {
  // Measured with `identity`, which hoists nothing and rewrites nothing. If the comparison could be
  // passed by normalizing everything away, this would drop.
  const identity: Hoister = (code) => passThrough(code)
  assert.equal(await countDisagreements('jest', identity), IDENTITY_DISAGREEMENTS.jest)
  assert.equal(await countDisagreements('vitest', identity), IDENTITY_DISAGREEMENTS.vitest)
})

/** Wraps the real engine: same analysis, and one edit to what it printed. */
function sabotage(edit: (code: string) => string): Hoister {
  return (code, policy, options) => {
    const output = hoistMocks(code, policy, options)
    return { ...output, code: edit(output.code) }
  }
}

function replaced(code: string, from: RegExp, to: string): string {
  const next = code.replace(from, to)
  assert.notEqual(next, code, `the sabotage found nothing to change in:\n${code}`)
  return next
}

const SABOTAGES: readonly {
  readonly what: string
  readonly runner: RunnerName
  readonly caseName: string
  readonly hoist: Hoister
  /** Why it must fail: the check that is the only one able to see this. */
  readonly reason: RegExp
}[] = [
  {
    what: 'dropping a binding rewrite',
    runner: 'jest',
    caseName: 'binding: an aliased named import',
    hoist: sabotage((code) => replaced(code, /__provino_import_\d+__\.n/, 'm')),
    reason: /^run log differs/,
  },
  {
    what: 'dropping a binding rewrite under Vitest',
    runner: 'vitest',
    caseName: 'binding: a namespace',
    hoist: sabotage((code) => replaced(code, /__provino_import_\d+__\.y/, 'n.y')),
    reason: /^run log differs/,
  },
  {
    what: 'reordering two hoisted calls',
    runner: 'jest',
    caseName: 'layout: mock, unmock, require, mock',
    hoist: sabotage((code) =>
      replaced(code, /(jest\.mock\("\.\/a"\);?\n)(jest\.unmock\("\.\/a"\);?\n)/, '$2$1'),
    ),
    reason: /^hoisted order differs/,
  },
  {
    what: 'dropping a hoisted const',
    runner: 'jest',
    caseName: 'const: a pure const a factory reads moves',
    hoist: sabotage((code) => replaced(code, /const a = "x";?\n/, '')),
    reason: /^hoisted order differs/,
  },
  {
    what: 'leaving an import static',
    runner: 'jest',
    caseName: 'const: a pure const a factory reads moves',
    hoist: sabotage((code) =>
      replaced(
        code,
        /const (__provino_import_0__) = await __provino_import__\("\.\/m"\);?/,
        'import * as $1 from "./m";',
      ),
    ),
    reason: /^hoisted order differs/,
  },
  {
    what: 'dropping the factory',
    runner: 'jest',
    caseName: 'factory: a factory and options',
    hoist: sabotage((code) => replaced(code, /, \(\) => \(\{\}\)/, '')),
    reason: /^run log differs/,
  },
  {
    what: 'returning no static mocks',
    runner: 'vitest',
    caseName: 'argument: unmock',
    hoist: (code, policy, options) => ({ ...hoistMocks(code, policy, options), staticMocks: [] }),
    reason: /^staticMocks differ/,
  },
  {
    what: 'returning no static mocks under Jest',
    runner: 'jest',
    caseName: 'argument: unmock: a string',
    hoist: (code, policy, options) => ({ ...hoistMocks(code, policy, options), staticMocks: [] }),
    reason: /^staticMocks differ/,
  },
  {
    what: 'reporting the wrong error code',
    runner: 'vitest',
    caseName: 'hoisted: exported',
    hoist: (code, policy, options) => {
      const output = hoistMocks(code, policy, options)
      return {
        ...output,
        diagnostics: output.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          code: 'HOIST_NOT_TOP_LEVEL' as const,
        })),
      }
    },
    reason: /^error code differs/,
  },
]

for (const { what, runner, caseName, hoist, reason } of SABOTAGES) {
  test(`sabotage: ${what} fails ${runner}: ${caseName}`, async () => {
    const found = await problem(runner, caseNamed(runner, caseName), {
      hoist,
      policy: POLICIES[runner],
    })
    assert.ok(found !== undefined, 'the sabotage passed')
    assert.match(found, reason)
  })
}

test('output that does not parse fails the case, even where the real hoister throws', async () => {
  const garbage: Hoister = () => passThrough('jest.mock(')
  await assert.rejects(
    problem('jest', plainCase('garbage', 'jest.mock("a", () => someGlobal)\n'), {
      hoist: garbage,
      policy: POLICIES.jest,
    }),
    /does not parse/,
  )
})

// ---------------------------------------------------------------------------------------------
// Not vacuous: every policy key is proved

for (const runner of RUNNERS) {
  test(`${runner}: every policy key has a flip that fails, or a reason it can't`, () => {
    const covered = new Set<string>([
      ...FLIPS[runner].map((flip) => flip.key),
      ...Object.keys(UNPROVABLE[runner]),
    ])
    assert.deepEqual(
      [...covered].toSorted(),
      Object.keys(POLICIES[runner]).toSorted(),
      'a new policy key needs a flip here',
    )
  })

  for (const { key, what, change, caseName } of FLIPS[runner]) {
    test(`flip ${runner} ${key} (${what}) fails "${caseName}"`, async () => {
      const found = await problem(runner, caseNamed(runner, caseName), {
        policy: { ...POLICIES[runner], ...change },
      })
      assert.ok(found !== undefined, 'the flip passed')
    })
  }
}
