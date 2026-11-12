// The resolution conditions the loader and the graph resolve with: one default in one place.

/** `conditions` when the caller gave some, else Node's (`['node']`). */
export function conditionsOf(options: {
  readonly conditions?: readonly string[] | undefined
}): readonly string[] {
  return options.conditions ?? ['node']
}
