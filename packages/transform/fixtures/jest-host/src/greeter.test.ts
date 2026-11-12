import { counter } from './counter.ts'
import { greet } from './deps.ts'
import { hello } from './greeter.ts'

const mockLabel: string = 'from-factory'

jest.mock('./deps')
jest.mock('./counter', () => ({ counter: (): string => mockLabel }))

describe('hoisted mocks', () => {
  it('serves the __mocks__ file for ./deps', () => {
    expect(greet('a')).toBe('manual:a')
  })

  it('serves a factory that reads a mock-prefixed variable', () => {
    expect(counter()).toBe('from-factory')
  })

  it('applies both to a module that imports them', () => {
    expect(hello('b')).toBe('manual:b/from-factory')
  })

  it.skip('is skipped', () => {
    expect(greet('c')).toBe('real:c')
  })

  it('erases types', () => {
    const value: number = 1
    expect(value).toBe(1)
  })
})
