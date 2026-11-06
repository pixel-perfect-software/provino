#!/usr/bin/env node
// One engine's side of `bench:mock` (T4.3): times creating mocks and calling one, and prints
// `PROVINO_SAMPLE {"create": ns, "createArrow": ns, "createFunction": ns, "createArrowUse": ns, "call": ns}`.
// Usage: entry.ts <provino-jest|provino-vitest|vitest-spy|jest-mock>. One engine per process.
//   creation  ns per mock; a batch of mocks is built, each from a new impl closure, and kept alive
//             (in `retained`) until the sample is printed, so the optimizer can't drop the creation
//   call      ns per call of a mock holding an impl; every result is summed and printed
// Each measurement runs ROUNDS rounds; the first WARMUP_ROUNDS are discarded, the rest are medians.
import { jestMockPolicy } from '@provino/dialect-jest'
import { vitestMockPolicy } from '@provino/harness'
import { createMockFn, createMockRegistry } from '@provino/mock'
import { SAMPLE_PREFIX } from '../internal/limits.ts'
import { median } from '../stats.ts'
import { ENGINES, type Engine, ROUNDS, type Sample, WARMUP_ROUNDS } from './report.ts'

/** Mocks per creation round, and calls per call round. */
const MOCKS_PER_ROUND = 20_000
const CALLS_PER_ROUND = 200_000

type Maker = (impl?: (...args: never[]) => unknown) => unknown
type Callable = (n: number) => unknown

interface Subject {
  /** Builds a mock, with `impl` if given. */
  readonly make: Maker
  /** Builds a mock with an impl, for the call rounds. */
  readonly callable: () => Callable
}

async function subjectFor(engine: Engine): Promise<Subject> {
  switch (engine) {
    case 'provino-jest':
    case 'provino-vitest': {
      const policy = engine === 'provino-vitest' ? vitestMockPolicy : jestMockPolicy
      const registry = createMockRegistry()
      return {
        make: (impl?: (...args: never[]) => unknown) =>
          createMockFn(policy, registry, impl === undefined ? undefined : { impl }),
        callable: () => createMockFn(policy, registry, { impl: (n: number) => n + 1 }),
      } as unknown as Subject
    }
    case 'vitest-spy': {
      const { fn } = await import('@vitest/spy')
      return { make: fn as Maker, callable: () => fn((n: number) => n + 1) } as unknown as Subject
    }
    case 'jest-mock': {
      const { ModuleMocker } = await import('jest-mock')
      const mocker = new ModuleMocker(globalThis)
      return {
        make: ((impl?: (...args: never[]) => unknown) =>
          impl === undefined ? mocker.fn() : mocker.fn(impl as never)) as Maker,
        callable: () => mocker.fn((n: number) => n + 1),
      } as unknown as Subject
    }
  }
}

/** Every mock built, kept until exit so creation can't be optimized away. */
const retained: unknown[] = []

function keptMedian(perRound: readonly number[]): number {
  return median(perRound.slice(WARMUP_ROUNDS))
}

/** ns per mock for `build(i)`, retaining every mock of a round until the next one starts. */
function timeCreate(build: (i: number) => unknown): number {
  const perRound: number[] = []
  for (let round = 0; round < ROUNDS; round++) {
    retained.length = 0
    const start = process.hrtime.bigint()
    for (let i = 0; i < MOCKS_PER_ROUND; i++) retained.push(build(i))
    perRound.push(Number(process.hrtime.bigint() - start) / MOCKS_PER_ROUND)
  }
  return keptMedian(perRound)
}

let sink = 0

function timeCall(callable: Callable): number {
  const perRound: number[] = []
  for (let round = 0; round < ROUNDS; round++) {
    // Every engine records each call, so history is cleared between rounds, outside the timing,
    // or the largest engine runs out of memory.
    ;(callable as unknown as { mockClear(): void }).mockClear()
    let sum = 0
    const start = process.hrtime.bigint()
    for (let i = 0; i < CALLS_PER_ROUND; i++) sum += callable(i) as number
    perRound.push(Number(process.hrtime.bigint() - start) / CALLS_PER_ROUND)
    sink += sum
  }
  return keptMedian(perRound)
}

const engine = ENGINES.find((name) => name === process.argv[2])
if (engine === undefined) {
  throw new Error(`usage: entry.ts <${ENGINES.join('|')}>, got ${String(process.argv[2])}`)
}
const { make, callable } = await subjectFor(engine)
const result: Sample = {
  // A new closure per iteration: `i` is captured, so no two impls are the same function.
  create: timeCreate(() => make()),
  createArrow: timeCreate((i) => make(() => i)),
  createFunction: timeCreate((i) =>
    make(function impl() {
      return i
    }),
  ),
  // First use, which creation defers: one call and one read of `.mock.calls`, then kept like the rest.
  createArrowUse: timeCreate((i) => {
    const mock = make(() => i) as ((n: number) => unknown) & { mock: { calls: unknown[] } }
    mock(0)
    sink += mock.mock.calls.length
    return mock
  }),
  call: timeCall(callable()),
}
// Print the retained count and the call sum, so both are read.
process.stderr.write(`bench:mock ${engine}: kept ${retained.length} mocks, call sum ${sink}\n`)
process.stdout.write(`${SAMPLE_PREFIX}${JSON.stringify(result)}\n`)
