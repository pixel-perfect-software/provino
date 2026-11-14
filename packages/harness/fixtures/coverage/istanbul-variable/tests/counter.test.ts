import { bump } from '../src/counter.ts'

type Counters = Record<string, { readonly f: Record<string, number> }>

const counters = (): Counters =>
  (globalThis as unknown as { readonly __coverage__: Counters }).__coverage__

test('the counters live in globalThis.__coverage__, keyed by the module path', () => {
  expect(Object.keys(counters()).map((path) => path.split('/').slice(-2).join('/'))).toEqual([
    'src/counter.ts',
  ])
})

test('a call moves its function counter in that global', () => {
  const [path] = Object.keys(counters())
  const before = counters()[path as string]?.f['0'] ?? -1
  bump()
  expect(counters()[path as string]?.f['0']).toBe(before + 1)
})
