import { availableParallelism } from 'node:os'

/** How many commands of one kind run at once: enough to overlap their waits, few enough not to thrash. */
export const CONCURRENCY: number = Math.min(4, availableParallelism())

/**
 * Runs `task` on each item, at most `limit` at once, and returns the results in the order of
 * `items` whatever order they finish in, so output built from them stays in item order. The first
 * rejection rejects the whole.
 * @internal
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<readonly R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const lane = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await task(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return results
}
