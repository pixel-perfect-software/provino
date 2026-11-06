import { value } from './dep.ts'

const topLevel = String('declared after the hoisted call')

vi.mock('./dep.ts', () => ({ value: topLevel }))

test('never reached', () => observe('never reached', () => ({ value })))
