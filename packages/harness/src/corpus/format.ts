// Small text helpers the corpus commands and the gate report share.

/**
 * Milliseconds as seconds with one decimal, `3.2 s`.
 * @internal
 */
export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

/**
 * Counts as `passed 12, failed 1`, in the record's order.
 * @internal
 */
export function countList(counts: Readonly<Record<string, number | undefined>>): string {
  return Object.entries(counts)
    .map(([name, count]) => `${name} ${count}`)
    .join(', ')
}
