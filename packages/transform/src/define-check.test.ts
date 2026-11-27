import { describe, expect, it } from 'provino'
import { refusedDefines } from './define-check.ts'

describe('refusedDefines', () => {
  it('names each value Oxc does not take as one expression, with its reason', () => {
    const refused = refusedDefines({
      A: '1 +',
      B: 'a; b',
      C: '"a" "b"',
      D: 'a) + (b',
      OK: '{"DEV":true}',
      SEQ: 'a, b',
    })
    expect(Object.keys(refused)).toEqual(['A', 'B', 'C', 'D'])
    expect(refused.A).toBe('Unexpected token')
  })

  it('is empty when every value is accepted', () => {
    expect(refusedDefines({ 'import.meta.env.DEV': 'true', __V__: '"1"' })).toEqual({})
  })
})
