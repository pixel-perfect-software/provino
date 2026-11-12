// The timer members of `jest`: what they are, what they return, and that they act on the clock of
// the file running when they are called. Their behaviour against the real Jest is the harness's
// timer corpus (`mocking/timers-*`).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMockRegistry } from '@provino/mock'
import { resolvePolicy } from '@provino/policy'
import { createFakeClock, type FakeClock } from '@provino/timers'
import type { MockPolicy } from '@provino/types'
import { jestPolicy } from '../dialect.ts'
import { type JestGlobalsHost, type JestObject, jestGlobals, jestModuleScope } from './globals.ts'
import { runRegistered, setUpJestExpect, standInGlobal } from './internal/test-support.ts'

const policy = resolvePolicy(jestPolicy)

/** A `jest` over a clock on a stand-in global; `swap` replaces the clock `host.timers()` returns. */
async function jestOver(t: Parameters<typeof setUpJestExpect>[0]): Promise<{
  readonly jest: JestObject
  readonly module: JestObject
  readonly env: typeof globalThis
  readonly warnings: string[]
  readonly swap: (clock: FakeClock) => void
}> {
  const { expect } = setUpJestExpect(t)
  const warnings: string[] = []
  const env = standInGlobal(warnings)
  let clock = createFakeClock(env, policy.timers)
  const mocks = createMockRegistry()
  let host: JestGlobalsHost | undefined
  let jest: JestObject | undefined
  await runRegistered((api) => {
    host = {
      api,
      expect,
      registry: () => {
        throw new Error('this test does not use the module registry')
      },
      mocks: () => mocks,
      moduleMocks: () => {
        throw new Error('this test does not use the module-mock registry')
      },
      mockPolicy: policy.mock as MockPolicy,
      timers: () => clock,
      timersPolicy: policy.timers,
      seed: 0,
      environmentTornDown: () => false,
      setDefaultTimeout: () => {},
    }
    jest = jestGlobals(host).jest
  }, policy.core)
  assert.ok(host && jest)
  const module = jestModuleScope(host)('/a.ts').jest as JestObject
  const swap = (next: FakeClock): void => {
    clock = next
  }
  return { jest, module, env, warnings, swap }
}

test('the global jest and a module`s own jest have the timer members of Jest 30.5', async (t) => {
  const { jest, module } = await jestOver(t)
  const names = [
    'useFakeTimers',
    'useRealTimers',
    'runAllTimers',
    'runAllTimersAsync',
    'runOnlyPendingTimers',
    'runOnlyPendingTimersAsync',
    'advanceTimersByTime',
    'advanceTimersByTimeAsync',
    'advanceTimersToNextTimer',
    'advanceTimersToNextTimerAsync',
    'advanceTimersToNextFrame',
    'runAllTicks',
    'clearAllTimers',
    'getTimerCount',
    'now',
    'setSystemTime',
    'getRealSystemTime',
    'setTimerTickMode',
    'runAllImmediates',
  ]
  for (const object of [jest, module]) {
    for (const name of names) assert.equal(typeof Reflect.get(object, name), 'function', name)
    // Vitest's members are not Jest's.
    assert.equal('isFakeTimers' in object, false)
    assert.equal('getMockedSystemTime' in object, false)
  }
})

test('useFakeTimers, useRealTimers and setTimerTickMode return the object; the rest return nothing', async (t) => {
  const { jest, module } = await jestOver(t)
  for (const object of [jest, module]) {
    assert.equal(object.useFakeTimers(), object)
    assert.equal(object.setTimerTickMode({ mode: 'manual' }), object)
    assert.equal(object.advanceTimersByTime(1), undefined)
    assert.equal(object.runAllTimers(), undefined)
    assert.equal(object.clearAllTimers(), undefined)
    assert.equal(object.setSystemTime(0), undefined)
    assert.equal(await object.advanceTimersByTimeAsync(1), undefined)
    assert.equal(object.useRealTimers(), object)
  }
})

test('the timer members act on the clock of the file running when they are called', async (t) => {
  const { jest, env, swap } = await jestOver(t)
  const policyTimers = policy.timers
  const second = createFakeClock(env, policyTimers)
  jest.useFakeTimers({ now: 100 })
  assert.equal(jest.now(), 100)
  jest.useRealTimers()
  swap(second)
  jest.useFakeTimers({ now: 5000 })
  assert.equal(jest.now(), 5000, 'now reads the clock the host hands out now')
  jest.useRealTimers()
})

test('runAllImmediates is for legacy timers, which Provino lacks', async (t) => {
  const { jest } = await jestOver(t)
  assert.throws(
    () => jest.runAllImmediates(),
    new TypeError('`jest.runAllImmediates()` is only available when using legacy fake timers.'),
  )
})

test('advancing while timers are real warns with Jest`s text and carries on', async (t) => {
  const { jest, warnings } = await jestOver(t)
  jest.advanceTimersByTime(10)
  assert.equal(warnings.length, 1)
  assert.match(
    warnings[0] ?? '',
    /^A function to advance timers was called but the timers APIs are not replaced with fake timers\. Call `jest\.useFakeTimers\(\)` in this test file or enable fake timers for all tests by setting 'fakeTimers': \{'enableGlobally': true\} in Jest configuration file\.\nStack Trace:\n/,
  )
})

test('legacy fake timers are refused when a test installs them', async (t) => {
  const { jest } = await jestOver(t)
  assert.throws(
    () => jest.useFakeTimers({ legacyFakeTimers: true }),
    (error) => (error as { code?: string }).code === 'TIMERS_LEGACY_UNSUPPORTED',
  )
})
