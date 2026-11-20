// The words of `vitestFixtureMessages` against the installed Vitest 5.0.5 (D27: the pinned
// package's own text, in-process). Each message is built with sentinel values, and every piece of
// text between them must appear in Vitest's runner chunk, with its concatenated literals joined.
// The registration errors are also held to recordings (`fixtures/runtime/fixture-error-*`,
// `fixture-parse-error`, `fixture-cycle`); this covers the ones no recording can show: an
// `AggregateError`'s own message, a second `onCleanup`, and the suite-hook errors, which Vitest's
// JSON drops.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import type { DefinitionErrorInfo, DefinitionErrorKind } from '@provino/types'
import { vitestFixtureMessages } from './fixture-messages.ts'

/** Vitest's runner chunk: the one dist file that holds the fixture texts. */
function runnerSource(): string {
  const root = dirname(createRequire(import.meta.url).resolve('vitest/package.json'))
  const chunks = join(root, 'dist', 'chunks')
  for (const name of readdirSync(chunks)) {
    if (!name.endsWith('.js')) continue
    const text = readFileSync(join(chunks, name), 'utf8')
    // Join literals split by `+`, so a message written over several reads as one.
    if (text.includes('Cannot resolve user fixtures'))
      return text.replace(/[`'"]\s*\+\s*[`'"]/g, '')
  }
  throw new Error('no Vitest chunk holds the fixture texts')
}

const SENTINEL = '<<provino-sentinel>>'

function info(
  kind: DefinitionErrorKind,
  code: string,
  params: readonly string[],
): DefinitionErrorInfo {
  return {
    kind,
    code,
    key: SENTINEL,
    message: 'core words',
    params: Object.fromEntries(params.map((name) => [name, SENTINEL])),
  }
}

/**
 * Each case: its name, the error, Vitest's class, and where Vitest's source puts a conditional part
 * of the text (`${cond ? ' …' : ''}`): the message is cut there too, as no literal spans it.
 */
const CASES: readonly (readonly [string, DefinitionErrorInfo, string, (readonly string[])?])[] = [
  ['scope-conflict', info('dependency', 'scope-conflict', ['scope']), 'FixtureDependencyError'],
  ['auto-conflict', info('dependency', 'auto-conflict', ['auto']), 'FixtureDependencyError'],
  ['unknown-scope', info('dependency', 'unknown-scope', ['scope']), 'FixtureDependencyError'],
  [
    'scope-in-describe, inherited',
    {
      ...info('dependency', 'scope-in-describe', ['scope']),
      params: { scope: SENTINEL, inherited: 'true' },
    },
    'FixtureDependencyError',
    [' (inherited from the base fixture)', ' inside the describe block'],
  ],
  [
    'unknown-dependency',
    info('dependency', 'unknown-dependency', ['dependency']),
    'FixtureDependencyError',
  ],
  ['self-without-parent', info('dependency', 'self-without-parent', []), 'FixtureDependencyError'],
  [
    'narrower-dependency',
    info('dependency', 'narrower-dependency', ['scope', 'dependency', 'dependencyScope']),
    'FixtureDependencyError',
  ],
  ['many', info('dependency', 'many', []), 'AggregateError'],
  [
    'test-scoped-in-suite-hook',
    info('dependency', 'test-scoped-in-suite-hook', ['hook', 'keys', 'alternative']),
    'FixtureDependencyError',
  ],
  ['use-not-called', info('dependency', 'use-not-called', []), 'Error'],
  ['cycle', info('dependency', 'cycle', ['cycle']), 'Error'],
  [
    'suite-hook-no-context',
    info('access', 'suite-hook-no-context', ['hook', 'keys']),
    'FixtureAccessError',
  ],
  [
    'not-destructured, from a suite hook',
    info('parse', 'not-destructured', ['position', 'received', 'next', 'suiteHook']),
    'FixtureParseError',
    [' If you used internal'],
  ],
  ['rest-element', info('parse', 'rest-element', ['received']), 'FixtureParseError'],
  ['cleanup-twice', info('dependency', 'cleanup-twice', []), 'Error'],
]

const source = runnerSource()

/** `pieces` cut again before each of `cuts`, which starts the part after it. */
function cutBefore(pieces: readonly string[], cuts: readonly string[]): string[] {
  let out = [...pieces]
  for (const cut of cuts) {
    out = out.flatMap((piece) => piece.split(cut).map((part, i) => (i === 0 ? part : cut + part)))
  }
  return out.filter((piece) => piece !== '')
}

for (const [name, error, className, cuts = []] of CASES) {
  test(`${name}: Vitest 5.0.5's class and every piece of its text`, () => {
    const worded = vitestFixtureMessages(error)
    assert.equal(worded.name, className)
    const pieces = cutBefore(worded.message.split(SENTINEL), cuts)
    assert.ok(pieces.length > 0)
    for (const piece of pieces) {
      // A line break in the message is written as an escape in the chunk's source.
      const written = piece.replaceAll('\n', '\\n')
      assert.ok(source.includes(written), `Vitest's chunk has no "${written}"`)
    }
  })
}

test("an unknown code keeps core's words under the class of its kind", () => {
  assert.deepEqual(vitestFixtureMessages(info('access', 'from-a-newer-core', [])), {
    name: 'FixtureAccessError',
    message: 'core words',
  })
})
