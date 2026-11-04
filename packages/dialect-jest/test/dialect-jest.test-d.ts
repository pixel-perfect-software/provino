// The public API of @provino/dialect-jest (B08: the `expect` slice; B10: the dialect value and
// its globals).
import { jestDialect, jestExpectPolicy, jestPolicy } from '@provino/dialect-jest'
import {
  type JestGlobals,
  type JestGlobalsHost,
  type JestObject,
  jestExpectTable,
  jestGlobals,
} from '@provino/dialect-jest/runtime'
import { moduleRef } from '@provino/policy'
import type {
  Dialect,
  ExpectPolicy,
  ExpectTable,
  GlobalsFactory,
  GlobalsHost,
  MatcherTableFactory,
  ModuleRef,
  PolicyOverrides,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

expectTypeOf(jestExpectPolicy).toEqualTypeOf<ExpectPolicy>()
expectTypeOf(jestExpectTable).toExtend<MatcherTableFactory>()
expectTypeOf(jestExpectTable).returns.toEqualTypeOf<ExpectTable>()

// @ts-expect-error the factory takes no arguments
jestExpectTable({})
// @ts-expect-error the policy is read-only
jestExpectPolicy.expand = true

// The dialect value.
expectTypeOf(jestDialect).toEqualTypeOf<Dialect<'jest'>>()
expectTypeOf(jestDialect.name).toEqualTypeOf<'jest'>()
expectTypeOf(jestPolicy).toEqualTypeOf<PolicyOverrides>()
expectTypeOf(jestDialect.globals).toEqualTypeOf<Dialect<'jest'>['globals']>()

// @ts-expect-error a dialect is not renamed
jestDialect.version = '31'
// @ts-expect-error the policy overrides are read-only
jestPolicy.core = {}
declare function define(dialect: Dialect): void
define({
  name: 'x',
  version: '1',
  policy: {},
  // @ts-expect-error `globals` is a factory ref and names; the old `{ module, names }` shape is gone
  globals: { module: 'a', names: [] },
})

// The globals factory.
expectTypeOf(jestGlobals).toExtend<GlobalsFactory>()
expectTypeOf(jestGlobals).parameter(0).toEqualTypeOf<JestGlobalsHost>()
expectTypeOf(jestGlobals).returns.toEqualTypeOf<JestGlobals>()
expectTypeOf<JestGlobalsHost>().toExtend<GlobalsHost>()
expectTypeOf<JestGlobals>().toExtend<Readonly<Record<string, unknown>>>()
expectTypeOf<JestGlobals['jest']>().toEqualTypeOf<JestObject>()
expectTypeOf<JestObject['isolateModules']>().returns.toEqualTypeOf<JestObject>()
expectTypeOf<JestObject['isolateModulesAsync']>().returns.toEqualTypeOf<Promise<void>>()
expectTypeOf<JestObject['resetModules']>().returns.toEqualTypeOf<JestObject>()

// `jestGlobals` can be the target of the ref `Dialect.globals` takes.
expectTypeOf<ModuleRef<typeof jestGlobals>>().toExtend<ModuleRef<GlobalsFactory>>()
declare function useRef(ref: ModuleRef<GlobalsFactory>): void
useRef(moduleRef<typeof jestGlobals>('file:///x.ts', 'jestGlobals'))
// @ts-expect-error a function that does not build a record of globals is not a GlobalsFactory
useRef(moduleRef<() => number>('file:///x.ts', 'count'))

declare const host: JestGlobalsHost
const globals = jestGlobals(host)
// @ts-expect-error the full `jest` object (mocks, timers) is T11.10, not here yet
globals.jest.fn()
// @ts-expect-error the globals are read-only
globals.fit = globals.it
// @ts-expect-error a host needs core's API and an `expect`
jestGlobals({ registry: host.registry })
// @ts-expect-error `isolateModules` takes a function
globals.jest.isolateModules('./module')
