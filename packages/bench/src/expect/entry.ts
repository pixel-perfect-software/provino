#!/usr/bin/env node
// One engine's side of `bench:expect` (Track 7 spike F, ported in B08): times passing `toBe` and
// `toEqual` assertions and prints `PROVINO_SAMPLE {"toBe": ns, "toEqual": ns}` (ns per call) on a
// line of its own. Usage: entry.ts <provino|jest|provino-vitest|vitest>. Each engine gets its own
// process: each claims the realm's matcher slot.
//   provino         the Jest dialect's `expect` on `@provino/expect`, installed as the worker will
//                   (slot, table, per-test state) and called inside a current-test frame, so the
//                   state lookup is in the measurement
//   jest            `expect@30.5.2` as Jest's runtime loads it
//   provino-vitest  the same, with the Vitest dialect's slice and table (B25b, T7.6)
//   vitest          `@vitest/expect` 5.0.5 as Vitest sets Chai up (`integrations/chai/setup.ts`), reached
//                   from `vitest`; its `expect(x)` is Chai's, one `Assertion` per call
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { currentTest } from '@provino/core'
import { jestExpectPolicy } from '@provino/dialect-jest'
import { jestExpectTable } from '@provino/dialect-jest/runtime'
import { vitestPolicy } from '@provino/dialect-vitest'
import { vitestExpectTable } from '@provino/dialect-vitest/runtime'
import {
  createExpect,
  createMatcherRegistry,
  createStateSource,
  installMatchersSlot,
} from '@provino/expect'
import { resolvePolicy } from '@provino/policy'
import type { ExpectPolicy, ExpectTable, Frame, TaskId, TestTask } from '@provino/types'
import { SAMPLE_PREFIX } from '../internal/limits.ts'
import { median } from '../stats.ts'

/**
 * Calls per timed round, by engine, and rounds per process (the first is a warm-up and not kept).
 * Jest's `expect` costs about 60 times more per call, so a tenth of the calls still gives it rounds
 * of about 0.2 s, and the bench no longer spends minutes on Jest's side alone.
 */
const CALLS_PER_ROUND = {
  provino: 200_000,
  jest: 20_000,
  'provino-vitest': 200_000,
  vitest: 20_000,
} as const
const ROUNDS = 8

/** The `toEqual` payload (spike F's isn't given; B08 notes). */
const payload = { a: 1, b: [1, 2, 3], c: { d: 'x', e: [true, null] } }
const same = structuredClone(payload)

interface Assert {
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
}
type Expect = (actual: unknown) => Assert

/** The median ns per call over the kept rounds of `calls` calls each. */
function time(calls: number, call: () => void): number {
  const perCall: number[] = []
  for (let round = 0; round < ROUNDS; round++) {
    const start = process.hrtime.bigint()
    for (let i = 0; i < calls; i++) call()
    const ns = Number(process.hrtime.bigint() - start) / calls
    if (round > 0) perCall.push(ns)
  }
  return median(perCall)
}

function measure(expect: Expect, calls: number): { toBe: number; toEqual: number } {
  return {
    toBe: time(calls, () => expect(1).toBe(1)),
    toEqual: time(calls, () => expect(payload).toEqual(same)),
  }
}

/** `expect` on `@provino/expect` under `policy` and `table`, inside a current-test frame. */
function provinoMeasure(policy: ExpectPolicy, table: () => ExpectTable, calls: number) {
  const source = createStateSource(currentTest, {
    nameSeparator: ' ',
    expand: false,
    outsideTestCounts: policy.outsideTestCounts,
  })
  const registry = createMatcherRegistry()
  installMatchersSlot(source, registry)
  const expect = createExpect({ policy, table: table(), source, registry })
  const test = { type: 'test', id: 'bench', fullName: ['bench'] } as unknown as TestTask
  const frame: Frame = { test, hook: null, fileId: 'bench' as TaskId, attempt: 0, repeat: 0 }
  return currentTest.run(frame, () => measure(expect, calls))
}

const engine = process.argv[2]
let result: { toBe: number; toEqual: number }
if (engine === 'provino') {
  result = provinoMeasure(jestExpectPolicy, jestExpectTable, CALLS_PER_ROUND.provino)
} else if (engine === 'provino-vitest') {
  const policy = resolvePolicy(vitestPolicy).expect
  result = provinoMeasure(policy, vitestExpectTable, CALLS_PER_ROUND['provino-vitest'])
} else if (engine === 'vitest') {
  const fromVitest = createRequire(fileURLToPath(import.meta.resolve('vitest')))
  const upstream = (await import(
    pathToFileURL(fromVitest.resolve('@vitest/expect')).href
  )) as Record<string, unknown> & { chai: { use(plugin: unknown): void; expect: Expect } }
  for (const plugin of [
    'JestExtend',
    'JestChaiExpect',
    'ChaiStyleAssertions',
    'JestAsymmetricMatchers',
  ]) {
    upstream.chai.use(upstream[plugin])
  }
  result = measure(upstream.chai.expect, CALLS_PER_ROUND.vitest)
} else if (engine === 'jest') {
  const { expect } = await import('expect')
  result = measure(expect as unknown as Expect, CALLS_PER_ROUND.jest)
} else {
  throw new Error(`usage: entry.ts <provino|jest|provino-vitest|vitest>, got ${String(engine)}`)
}
process.stdout.write(`${SAMPLE_PREFIX}${JSON.stringify(result)}\n`)
