jest.mock('./does-not-exist.ts', () => ({ who: 'mock-of-nothing' }))

test('never reached', () => observe('never reached', () => require('./does-not-exist.ts')))
