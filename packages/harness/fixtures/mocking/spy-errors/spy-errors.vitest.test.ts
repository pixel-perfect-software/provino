// Vitest's spyOn and vi.fn errors the other fixtures don't reach.
const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}
const thrown = (run: () => unknown): unknown => {
  try {
    run()
    return 'did not throw'
  } catch (error) {
    return error
  }
}
const spyOn = vi.spyOn as unknown as (object: unknown, key: unknown) => unknown

c('spyOn on a primitive', () => thrown(() => spyOn(1, 'toFixed')))

c('a mock of an arrow called with new, and what it warns', () => {
  const mock = vi.fn(() => 1) as unknown as new () => unknown
  const warned: unknown[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => {
    warned.push(args.join(' '))
  }
  try {
    return { threw: thrown(() => new mock()), warned }
  } finally {
    console.warn = warn
  }
})
