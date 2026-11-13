// Small helpers the coordinator's modules share. Not exported from the package.

/** `-1`, `0` or `1` by UTF-16 code unit order, which is the same on every machine (`localeCompare` is not). */
export function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** The message of a thrown value: an `Error`'s own, else the value as text. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** An object that is no array: the shape of a parsed JSON record or of a module's exports. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** What `raceAbort` resolves with when the signal came first. */
export const ABORTED: unique symbol = Symbol('aborted')

/**
 * `work`'s outcome, or `ABORTED` as soon as `signal` aborts (at once when it already has). Work
 * that can't be cancelled (a hook that hangs) is left running: what it throws after that is
 * nobody's to report, and the listener on `signal` is gone as soon as the race is decided.
 */
export async function raceAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof ABORTED> {
  work.catch(() => undefined)
  if (signal.aborted) return ABORTED
  const aborted = Promise.withResolvers<typeof ABORTED>()
  const onAbort = (): void => aborted.resolve(ABORTED)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([work, aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** How many files are `stat`ed (or resolved) at once: a project can have thousands. */
export const BATCH = 256

/** `fn` over `items`, a bounded number at a time; the results are in the items' order. */
export async function mapInBatches<Item, Result>(
  items: readonly Item[],
  size: number,
  fn: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = []
  for (let from = 0; from < items.length; from += size) {
    results.push(...(await Promise.all(items.slice(from, from + size).map((item) => fn(item)))))
  }
  return results
}
