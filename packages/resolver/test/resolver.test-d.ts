// The public API of @provino/resolver.
import { createResolver, type ResolverError, type ResolverErrorCode } from '@provino/resolver'
import type { CreateResolver, ResolveResult, Resolver } from '@provino/types'
import { expectTypeOf } from 'expect-type'

expectTypeOf(createResolver).toEqualTypeOf<CreateResolver>()
const resolver = createResolver({ root: '/', mappers: [], extensions: ['.ts'] })
expectTypeOf(resolver).toEqualTypeOf<Resolver>()
expectTypeOf(
  resolver.resolve('x', { importer: '/a.ts', kind: 'import', conditions: [] }),
).toEqualTypeOf<ResolveResult>()
expectTypeOf<ResolverError['code']>().toEqualTypeOf<ResolverErrorCode>()

// @ts-expect-error extensions are required
createResolver({ root: '/', mappers: [] })
// @ts-expect-error not a call kind
resolver.resolve('x', { importer: '/a.ts', kind: 'load', conditions: [] })
// @ts-expect-error exactOptionalPropertyTypes: tsconfig is omitted, not undefined
createResolver({ root: '/', mappers: [], extensions: [], tsconfig: undefined })
