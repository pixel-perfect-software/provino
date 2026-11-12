import { callOther } from './uses-other.ts'

jest.enableAutomock()
jest.deepUnmock('./uses-other.ts')

test('deepUnmock leaves the module and what it imports real', () => {
  expect(callOther()).toBe(42)
})
