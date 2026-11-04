// Vitest found a worker's stdio is lost on terminate unless an empty write's callback has fired.
// Only a stream with bytes still buffered needs it: an empty write otherwise waits on nothing, and
// in a thread it costs a round trip through the coordinator's event loop.

/** A stream to flush: `process.stdout`, `process.stderr`, or a stand-in. */
interface Flushable {
  readonly writableLength?: number
  write(chunk: string, callback: () => void): unknown
}

/**
 * Waits until what was written to `stream` has been handed on: an empty write's callback when
 * bytes are buffered, nothing when none are. `write` is the stream's own (a captured stream's
 * original).
 */
export function flushStream(
  stream: Flushable,
  write: Flushable['write'] = stream.write,
): Promise<void> {
  if (stream.writableLength === 0) return Promise.resolve()
  return new Promise((resolve) => {
    Reflect.apply(write, stream, ['', () => resolve()])
  })
}

/** Flushes this process's stdout and stderr. */
export async function flushStdio(): Promise<void> {
  await Promise.all([flushStream(process.stdout), flushStream(process.stderr)])
}
