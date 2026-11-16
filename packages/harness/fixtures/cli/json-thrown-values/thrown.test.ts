test('an object with a message', () => {
  throw { message: 'boom' }
})

test('an object with a message and a code', () => {
  throw { code: 'E_CODE', message: 'with a code' }
})

test('an error with its own stack', () => {
  const error = new Error('own')
  Object.defineProperty(error, 'stack', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: 'Error: own\n    at somewhere (lib.js:1:1)',
  })
  throw error
})

test('an object with only a stack', () => {
  throw { stack: 'only a stack' }
})

test('an object with a message and a stack', () => {
  throw { message: 'the message', stack: 'the stack' }
})

test('an object with a message and a toJSON', () => {
  throw { message: 'kept', toJSON: () => ({ other: 1 }) }
})
