// @provino/dialect-vitest: the Vitest 5.0 dialect (B14a). Its policy values, each backed by
// recorded ground truth (T1.7), the names of its globals and its type entries. The config reader,
// the CLI flags and the `vitest` facade come with T11.15 and T11.16 (Phase 2).
export { type VitestDialectOptions, vitestDialect, vitestPolicy } from './dialect.ts'
export { VITEST_EACH_TITLE_TRUNCATE } from './each/title-truncate.ts'
export { vitestHoistPolicy } from './hoist-policy.ts'
export { vitestMockPolicy, vitestModulePolicy } from './mock-policy.ts'
