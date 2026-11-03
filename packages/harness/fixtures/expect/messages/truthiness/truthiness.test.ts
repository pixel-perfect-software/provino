class Animal {}
class Plant {}
// An element of an array literal gets no inferred name, so this class's `name` is ''.
const anonymous = [class {}][0]

describe('truthy and falsy', () => {
  test('toBeTruthy with 0', () => {
    expect(0).toBeTruthy()
  })

  test('not.toBeTruthy with a string', () => {
    expect('x').not.toBeTruthy()
  })

  test('toBeFalsy with 1', () => {
    expect(1).toBeFalsy()
  })

  test('not.toBeFalsy with an empty string', () => {
    expect('').not.toBeFalsy()
  })
})

describe('null, undefined and defined', () => {
  test('toBeNull with undefined', () => {
    expect(undefined).toBeNull()
  })

  test('not.toBeNull with null', () => {
    expect(null).not.toBeNull()
  })

  test('toBeUndefined with 0', () => {
    expect(0).toBeUndefined()
  })

  test('not.toBeUndefined with undefined', () => {
    expect(undefined).not.toBeUndefined()
  })

  test('toBeDefined with undefined', () => {
    expect(undefined).toBeDefined()
  })

  test('not.toBeDefined with an object', () => {
    expect({ a: 1 }).not.toBeDefined()
  })
})

describe('toBeInstanceOf', () => {
  test('toBeInstanceOf a named class with another class', () => {
    expect(new Plant()).toBeInstanceOf(Animal)
  })

  test('toBeInstanceOf an anonymous class', () => {
    expect(new Plant()).toBeInstanceOf(anonymous)
  })

  test('toBeInstanceOf with a primitive received', () => {
    expect(1).toBeInstanceOf(Animal)
  })

  test('not.toBeInstanceOf its own class', () => {
    expect(new Animal()).not.toBeInstanceOf(Animal)
  })

  test('toBeInstanceOf a non-function expected is a matcher error', () => {
    expect(new Animal()).toBeInstanceOf({} as unknown as typeof Animal)
  })
})
