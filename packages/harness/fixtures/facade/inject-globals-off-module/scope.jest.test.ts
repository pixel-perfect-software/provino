import { expect, jest as importedJest, it } from '@jest/globals'
import { typeofJestInModule } from './detect.ts'

it('has no jest in this module', () => {
  expect(typeof jest).toBe('undefined')
})

it('has no jest in a module it imports', () => {
  expect(typeofJestInModule).toBe('undefined')
})

it('still serves one through @jest/globals', () => {
  expect(typeof importedJest.fn).toBe('function')
})
