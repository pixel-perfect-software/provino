// The public API of @provino/dialect-vitest (B14a, T11.1): the dialect value and its slices, the
// `/node` and `/runtime` stubs, and the `DialectRegistry` augmentation.
import {
  type VitestDialectOptions,
  vitestDialect,
  vitestHoistPolicy,
  vitestMockPolicy,
  vitestModulePolicy,
  vitestPolicy,
} from '@provino/dialect-vitest'
import { vitestNodeDialect } from '@provino/dialect-vitest/node'
import {
  type VitestDialectError,
  type VitestDialectErrorCode,
  vitestGlobals,
} from '@provino/dialect-vitest/runtime'
import { defineDialect } from '@provino/policy'
import type {
  Dialect,
  DialectName,
  GlobalsFactory,
  HoistPolicy,
  MockPolicy,
  ModulePolicy,
  PolicyOverrides,
  ProjectConfig,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

expectTypeOf(vitestDialect).toEqualTypeOf<Dialect<'vitest'>>()
expectTypeOf(vitestNodeDialect).toEqualTypeOf<Dialect<'vitest'>>()
expectTypeOf(vitestPolicy).toEqualTypeOf<PolicyOverrides>()
expectTypeOf(vitestMockPolicy).toEqualTypeOf<MockPolicy>()
expectTypeOf(vitestModulePolicy).toEqualTypeOf<ModulePolicy>()
expectTypeOf(vitestHoistPolicy).toEqualTypeOf<HoistPolicy>()
expectTypeOf(vitestGlobals).toExtend<GlobalsFactory>()
expectTypeOf<VitestDialectError['code']>().toEqualTypeOf<VitestDialectErrorCode>()
expectTypeOf<VitestDialectOptions>().toEqualTypeOf<Record<string, never>>()

// @ts-expect-error the policy is read-only
vitestMockPolicy.newCall = 'apply'

// Importing the package registers `vitest` as a dialect name.
expectTypeOf<'vitest'>().toExtend<DialectName>()
const project: ProjectConfig = { dialect: 'vitest' }
expectTypeOf(project).toExtend<ProjectConfig>()
// @ts-expect-error a dialect nobody registered is refused
const unknownDialect: ProjectConfig = { dialect: 'mocha' }

// `defineDialect` keeps the literal name.
expectTypeOf(defineDialect({ name: 'vitest', version: '5.0', policy: {} })).toEqualTypeOf<
  Dialect<'vitest', undefined>
>()
// @ts-expect-error a version is required
defineDialect({ name: 'vitest', policy: {} })
// @ts-expect-error a policy value outside its slice's type is refused
defineDialect({ name: 'vitest', version: '5.0', policy: { core: { firstArg: 'done' } } })

void unknownDialect
