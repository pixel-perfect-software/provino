// `provino/globals/native` (B27b): every native name on `globalThis`, typed as `ProvinoApi` types
// it. A project of its own: `provino/globals` declares `test` and `it` with the Jest dialect's
// types, and one program can't hold both.

import type { ProvinoApi, ProvinoTimers } from '@provino/api'
import { expectTypeOf } from 'expect-type'
import 'provino/globals/native'

expectTypeOf(globalThis.test).toEqualTypeOf<ProvinoApi['test']>()
expectTypeOf(globalThis.fn).toEqualTypeOf<ProvinoApi['fn']>()
expectTypeOf(globalThis.timers.useFakeTimers()).toEqualTypeOf<ProvinoTimers>()
expectTypeOf(globalThis.suite).toEqualTypeOf<ProvinoApi['suite']>()

// The native `test` has `extend`.
const withDb = globalThis.test.extend({ db: 1 })
withDb('reads it', ({ db }) => {
  expectTypeOf(db).toEqualTypeOf<number>()
})
// @ts-expect-error `fn` keeps its implementation's parameters
globalThis.fn((a: number) => a)('one')
// @ts-expect-error there is no `jest` global in a project with no dialect
globalThis.jest
// @ts-expect-error `mock` is imported from `provino`, never a global: only an import is hoisted
globalThis.mock
// @ts-expect-error `importActual` is an import too
globalThis.importActual
// @ts-expect-error `requireActual` is an import too
globalThis.requireActual
expectTypeOf(globalThis.mocked).toEqualTypeOf<ProvinoApi['mocked']>()
