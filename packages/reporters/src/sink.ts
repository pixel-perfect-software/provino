/**
 * Where text goes: `process.stdout`, a test's buffer. A `write` that returns a promise is
 * awaited, so output stays in order for a sink that is asynchronous.
 * @public
 */
export interface TextSink {
  write(chunk: string): unknown
}
