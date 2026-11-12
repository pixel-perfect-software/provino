import { callOther } from './uses-other.ts'

jest.enableAutomock()
jest.unmock('./uses-other.ts')

test('unmock leaves the module real and what it imports mocked', () => {
  expect(callOther()).toBeUndefined()
})
