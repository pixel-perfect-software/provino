// A promise-shaped object that notices when someone awaits it (T7.8). `await x` and `Promise.all`
// call `x.then`, so a test that never does is a test that never awaited the assertion. This is
// how an unawaited `.resolves`/`.rejects`/`expect.poll` is found at the test's end.

/**
 * A thenable over `source()` that calls `onAwaited` the first time anyone takes its result with
 * `then`, `catch` or `finally`. `source` is asked on each call, so a caller that wants a lazy
 * start memoizes it.
 * @internal
 */
export function awaitable<T>(source: () => Promise<T>, onAwaited: () => void): Promise<T> {
  const thenable = {
    // biome-ignore lint/suspicious/noThenProperty: a thenable is the point
    then<R1 = T, R2 = never>(
      onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
      onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
    ): Promise<R1 | R2> {
      onAwaited()
      return source().then(onFulfilled, onRejected)
    },
    catch<R = never>(
      onRejected?: ((reason: unknown) => R | PromiseLike<R>) | null,
    ): Promise<T | R> {
      onAwaited()
      return source().catch(onRejected)
    },
    finally(onFinally?: (() => void) | null): Promise<T> {
      onAwaited()
      return source().finally(onFinally)
    },
    [Symbol.toStringTag]: 'Promise',
  }
  return thenable as Promise<T>
}
