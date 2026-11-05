// @provino/dialect-jest: the Jest 30.5 dialect. B08 has its `expect` slice; B10 has the `Dialect`
// value (`jestDialect`) with Jest's policy values, all unverified until B14's T1.7, and the globals
// it injects. The config reader, the CLI flags and the facades come with T11.x (B14, B17).
export { type JestDialectOptions, jestDialect, jestPolicy } from './dialect.ts'
export { jestExpectPolicy } from './expect-policy.ts'
