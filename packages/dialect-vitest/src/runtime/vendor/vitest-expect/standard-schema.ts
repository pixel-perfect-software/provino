// provino: a stand-in for the `@standard-schema/spec` types (`StandardSchemaV1`), which this
// package does not depend on. Loose: the matchers read `~standard.validate` and its `issues`.

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': any
}

export declare namespace StandardSchemaV1 {
  type Result<Output> = any
}
