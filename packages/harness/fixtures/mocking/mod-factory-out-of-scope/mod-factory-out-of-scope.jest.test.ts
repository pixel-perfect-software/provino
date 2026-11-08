// A call result is not a pure constant, so Jest cannot hoist it with the factory and refuses it.
const outside = String('not allowed')

jest.mock('./dep.ts', () => ({ value: outside }))

test('never reached', () => observe('never reached', () => require('./dep.ts')))
