import { describe, expect, it, jest } from '@jest/globals'
import { greet } from './deps.ts'

jest.mock('./deps')

describe('everything from @jest/globals', () => {
  it('hoists jest.mock above the import', () => {
    expect(greet('a')).toBe('manual:a')
  })

  it('has the jest object', () => {
    const fn = jest.fn((): number => 1)
    expect(fn()).toBe(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
