// The snapshot state a runner gives a test holds the pretty-format options it serializes with:
// Jest's as `snapshotFormat`, Vitest's (the config's, over its defaults) as `_snapshotFormat`.
const stateOf = (): Record<string, unknown> =>
  (expect as unknown as { getState(): { snapshotState: Record<string, unknown> } }).getState()
    .snapshotState

test('snapshot.format.maxOutputLength', () =>
  observe('snapshot.format.maxOutputLength', () => {
    const state = stateOf()
    const format = (state.snapshotFormat ?? state._snapshotFormat) as { maxOutputLength?: number }
    return format.maxOutputLength ?? null
  }))
