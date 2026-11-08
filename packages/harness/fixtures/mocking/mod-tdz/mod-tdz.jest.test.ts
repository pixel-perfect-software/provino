import { value } from './dep.ts'

const mockValue = String('declared after the hoisted call')

jest.mock('./dep.ts', () => ({ value: mockValue }))

test('never reached', () => observe('never reached', () => ({ value })))
