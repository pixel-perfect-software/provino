// Vitest's half of the module-mock pair; `self-test` runs it as `modules.test.ts`, so both runners
// report the same file key.
import { greet } from './greet.ts'
import { add, multiply } from './math.ts'

vi.mock('./math.ts', async () => ({
  ...(await vi.importActual('./math.ts')),
  add: vi.fn(() => 42),
}))
vi.mock('./greet.ts')

describe('module mocks', () => {
  it('uses the factory', () => {
    expect(add(1, 2)).toBe(42)
  })

  it('keeps an actual export', () => {
    expect(multiply(2, 3)).toBe(6)
  })

  it('uses the adjacent __mocks__ file', () => {
    expect(greet('you')).toBe('mocked hello you')
  })

  it('records calls to the factory mock', () => {
    add(5, 6)
    expect(add).toHaveBeenCalledWith(5, 6)
  })
})
