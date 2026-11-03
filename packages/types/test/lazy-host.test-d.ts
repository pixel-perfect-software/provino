// T6.1: the host interface `@provino/lazy` needs (Track 6 §Module boundaries). B07 adds the
// check that core's executor host satisfies it (§4 D.23); here, the contract's own shape.
import type { LazyFrame, LazyHost, SuiteHandle, TestRunHandle } from '@provino/types'
import { expectTypeOf } from 'expect-type'

declare const host: LazyHost
declare const suite: SuiteHandle

// A frame is a test run (with its innermost suite) or a suite hook.
const frame = host.current()
if (frame?.kind === 'test') {
  expectTypeOf(frame.run).toEqualTypeOf<TestRunHandle>()
  expectTypeOf(frame.run.ctx.task.fullName).toEqualTypeOf<string>()
  expectTypeOf(frame.run.state).toEqualTypeOf<'running' | 'cleanup' | 'done'>()
}
if (frame?.kind === 'suite') {
  expectTypeOf(frame.hook).toEqualTypeOf<'beforeAll' | 'afterAll'>()
  // @ts-expect-error a suite frame has no test run
  void frame.run
}
expectTypeOf<LazyFrame['file']['root']>().toEqualTypeOf<SuiteHandle>()

// Eager values only add `beforeEach`/`beforeAll` hooks.
host.addHook(suite, 'beforeEach', () => undefined)
// @ts-expect-error eager values never add an afterEach hook
host.addHook(suite, 'afterEach', () => undefined)

// Slots are per handle, keyed by symbol.
expectTypeOf(host.workerSlots).toEqualTypeOf<Map<symbol, unknown>>()
expectTypeOf(suite.slots).toEqualTypeOf<Map<symbol, unknown>>()
// @ts-expect-error slots are keyed by symbol, not string
suite.slots.set('user', 1)

// The interface can be implemented without casts.
export const standIn: LazyHost = {
  collecting: () => undefined,
  current: () => undefined,
  addHook: () => undefined,
  runOf: () => undefined,
  onCollected: () => undefined,
  addWorkerTeardown: () => undefined,
  workerSlots: new Map<symbol, unknown>(),
}
