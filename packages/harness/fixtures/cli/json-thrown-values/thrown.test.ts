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
