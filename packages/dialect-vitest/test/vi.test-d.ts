// The public types of `vi`, `vitestGlobals` and `vitestModuleScope` (B25f, T11.16).
import {
  type VitestGlobals,
  type VitestObject,
  type VitestWhen,
  vitestGlobals,
  vitestModuleScope,
} from '@provino/dialect-vitest/runtime'
import type { Mock } from '@provino/mock'
import type { GlobalsFactory, ModuleScopeFactory } from '@provino/types'
import { expectTypeOf } from 'expect-type'

expectTypeOf(vitestGlobals).toExtend<GlobalsFactory>()
expectTypeOf(vitestModuleScope).toExtend<ModuleScopeFactory>()
expectTypeOf<VitestGlobals['vi']>().toEqualTypeOf<VitestObject>()
expectTypeOf<VitestGlobals['vitest']>().toEqualTypeOf<VitestObject>()

declare const vi: VitestObject

expectTypeOf(vi.fn((n: number) => String(n))).toEqualTypeOf<Mock<(n: number) => string>>()
expectTypeOf(vi.useFakeTimers().advanceTimersByTime(10)).toEqualTypeOf<VitestObject>()
expectTypeOf(vi.runAllTimersAsync()).toEqualTypeOf<Promise<VitestObject>>()
expectTypeOf(vi.getMockedSystemTime()).toEqualTypeOf<Date | null>()
expectTypeOf(vi.hoisted(() => 1)).toEqualTypeOf<number>()
expectTypeOf(vi.mock('./a.ts')).toEqualTypeOf<void>()
expectTypeOf(vi.when(vi.fn())).toEqualTypeOf<VitestWhen>()
expectTypeOf(vi.stubEnv('DEV', true)).toEqualTypeOf<VitestObject>()
expectTypeOf(vi.waitFor(() => 'x')).toEqualTypeOf<Promise<string>>()

// @ts-expect-error vi.mock takes a path string
vi.mock(1)
// @ts-expect-error vi.hoisted takes a factory
vi.hoisted(1)
// @ts-expect-error vi.stubEnv takes a string, a boolean or undefined
vi.stubEnv('A', 1)
// @ts-expect-error vi.setTimerTickMode takes Vitest's mode names
vi.setTimerTickMode('nextAsync')
// @ts-expect-error vi has no Jest-only members
vi.requireActual('./a.ts')
