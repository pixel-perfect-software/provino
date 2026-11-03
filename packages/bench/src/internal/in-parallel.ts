/**
 * Runs `work` over `items`, at most `limit` at a time, and resolves when all are done. `work` must
 * not throw; a rejection ends the whole run.
 * @internal
 */
export async function inParallel<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  // The workers draw from one iterator, so each item goes to exactly one of them.
  const queue = items.values()
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (const item of queue) await work(item)
  })
  await Promise.all(workers)
}
