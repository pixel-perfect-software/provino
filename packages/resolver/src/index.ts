// @provino/resolver: the module resolver (Track 3). The contract (`Resolver`, `ResolveResult`,
// `ResolverOptions`, `CreateResolver`) lives in @provino/types.
export type { ResolverErrorCode } from './errors.ts'
export { ResolverError } from './errors.ts'
export type { NameMapperOptions, NameMapperRule } from './mappers.ts'
export { createNameMapper, jestModuleNameMapper } from './mappers.ts'
export { createResolver } from './resolver.ts'
