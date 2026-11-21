// A mock-shaped value for the matcher tests: the `mock.calls` and `mock.results` the table reads.
type Results = readonly { readonly type: string; readonly value: unknown }[]

export function createMock(
  calls: readonly unknown[][],
  results: Results = calls.map((args) => ({ type: 'return', value: args[0] })),
): { mock: { calls: unknown[][]; results: Results } } {
  return { mock: { calls: calls.map((args) => [...args]), results } }
}
