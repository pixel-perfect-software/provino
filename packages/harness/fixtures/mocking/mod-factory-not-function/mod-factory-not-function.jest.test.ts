jest.mock('./dep.ts', 'not a function' as never)

test('never reached', () => observe('never reached', () => require('./dep.ts')))
