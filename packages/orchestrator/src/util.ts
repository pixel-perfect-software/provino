// Small helpers the coordinator's modules share. Not exported from the package.

/** `-1`, `0` or `1` by UTF-16 code unit order, which is the same on every machine (`localeCompare` is not). */
export function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** The message of a thrown value: an `Error`'s own, else the value as text. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
