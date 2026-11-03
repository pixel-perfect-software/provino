#!/usr/bin/env node
// One engine's side of `bench:expect` (Track 7 spike F, ported in B08): times passing `toBe` and
// `toEqual` assertions and prints `{"toBe": ns, "toEqual": ns}` per call. Usage: entry.ts
// <provino|jest>. Each engine gets its own process: both claim the realm's matcher slot.
//   provino  the Jest dialect's `expect` on `@provino/expect`, installed as the worker will (slot,
//            table, per-test state) and called inside a current-test frame, so the state lookup
//            is in the measurement
//   jest     `expect@30.5.2` as Jest's runtime loads it
import { currentTest } from '@provino/core'
import { jestExpectPolicy } from '@provino/dialect-jest'
import { jestExpectTable } from '@provino/dialect-jest/runtime'
import {
  createExpect,
  createMatcherRegistry,
  createStateSource,
  installMatchersSlot,
} from '@provino/expect'
import type { Frame, TaskId, TestTask } from '@provino/types'

/** Calls per timed round, and rounds per process (the first is a warm-up and not kept). */
const CALLS = 200_000
const ROUNDS = 8

/** The `toEqual` payload (spike F's isn't given; B08 notes). */
const payload = { a: 1, b: [1, 2, 3], c: { d: 'x', e: [true, null] } }
const same = structuredClone(payload)

interface Assert {
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
}
type Expect = (actual: unknown) => Assert

/** The median ns per call over the kept rounds. */
function time(call: () => void): number {
  const perCall: number[] = []
  for (let round = 0; round < ROUNDS; round++) {
    const start = process.hrtime.bigint()
    for (let i = 0; i < CALLS; i++) call()
    const ns = Number(process.hrtime.bigint() - start) / CALLS
    if (round > 0) perCall.push(ns)
  }
  perCall.sort((a, b) => a - b)
  const mid = perCall.length >> 1
  return perCall.length % 2 === 1
    ? (perCall[mid] ?? 0)
    : ((perCall[mid - 1] ?? 0) + (perCall[mid] ?? 0)) / 2
}

function measure(expect: Expect): { toBe: number; toEqual: number } {
  return {
    toBe: time(() => expect(1).toBe(1)),
    toEqual: time(() => expect(payload).toEqual(same)),
  }
}

const engine = process.argv[2]
let result: { toBe: number; toEqual: number }
if (engine === 'provino') {
  const source = createStateSource(currentTest, { nameSeparator: ' ', expand: false })
  const registry = createMatcherRegistry()
  installMatchersSlot(source, registry)
  const expect = createExpect({
    policy: jestExpectPolicy,
    table: jestExpectTable(),
    source,
    registry,
  }) as unknown as Expect
  const test = { type: 'test', id: 'bench', fullName: ['bench'] } as unknown as TestTask
  const frame: Frame = { test, hook: null, fileId: 'bench' as TaskId, attempt: 0 }
  result = currentTest.run(frame, () => measure(expect))
} else if (engine === 'jest') {
  const { expect } = await import('expect')
  result = measure(expect as unknown as Expect)
} else {
  throw new Error(`usage: entry.ts <provino|jest>, got ${String(engine)}`)
}
process.stdout.write(`${JSON.stringify(result)}\n`)
