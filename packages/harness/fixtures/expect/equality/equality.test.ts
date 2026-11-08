// Spike C's equality cases, rebuilt (Track 7 F4): 31 assertions, each its own test, so a golden
// holds the verdict of each runner. 26 are the same in Jest and Vitest; 5 are not, all about
// `Error` (a subclass, a `cause`, an own property, an `AggregateError`'s errors) and invalid
// `Date`s: Jest compares errors by message and two invalid dates as unequal; Vitest compares
// errors as node:assert does and two invalid dates as equal.
class Point {
  x: number
  y: number
  constructor(x: number, y: number) {
    this.x = x
    this.y = y
  }
}

describe('where Jest and Vitest agree', () => {
  test('01 toEqual: the same primitive', () => {
    expect(1).toEqual(1)
  })
  test('02 toEqual: nested objects and arrays', () => {
    expect({ a: [1, { b: 2 }], c: 'x' }).toEqual({ a: [1, { b: 2 }], c: 'x' })
  })
  test('03 toEqual: an undefined property is ignored', () => {
    expect({ a: 1, b: undefined }).toEqual({ a: 1 })
  })
  test('04 toStrictEqual: an undefined property is not', () => {
    expect({ a: 1, b: undefined }).toStrictEqual({ a: 1 })
  })
  test('05 toEqual: a sparse array and one filled with undefined', () => {
    // biome-ignore lint/suspicious/noSparseArray: the hole is the case
    expect([, 1]).toEqual([undefined, 1])
  })
  test('06 toStrictEqual: a sparse array and one filled with undefined', () => {
    // biome-ignore lint/suspicious/noSparseArray: the hole is the case
    expect([, 1]).toStrictEqual([undefined, 1])
  })
  test('07 toEqual: a class instance and a literal', () => {
    expect(new Point(1, 2)).toEqual({ x: 1, y: 2 })
  })
  test('08 toStrictEqual: a class instance and a literal', () => {
    expect(new Point(1, 2)).toStrictEqual({ x: 1, y: 2 })
  })
  test('09 toEqual: a non-enumerable property is ignored', () => {
    expect(Object.defineProperty({}, 'hidden', { value: 1, enumerable: false })).toEqual({})
  })
  test('10 toEqual: symbol keys with different values', () => {
    const key = Symbol('k')
    expect({ [key]: 1 }).toEqual({ [key]: 2 })
  })
  test('11 toEqual: symbol keys with the same value', () => {
    const key = Symbol('k')
    expect({ [key]: 1 }).toEqual({ [key]: 1 })
  })
  test('12 toEqual: equal typed arrays', () => {
    expect(new Uint8Array([1, 2])).toEqual(new Uint8Array([1, 2]))
  })
  test('13 toEqual: typed arrays of different types', () => {
    expect(new Uint8Array([1, 2])).toEqual(new Int8Array([1, 2]))
  })
  test('14 toEqual: equal maps', () => {
    expect(new Map([['a', { n: 1 }]])).toEqual(new Map([['a', { n: 1 }]]))
  })
  test('15 toEqual: equal sets', () => {
    expect(new Set([1, { n: 2 }])).toEqual(new Set([1, { n: 2 }]))
  })
  test('16 toEqual: different sets', () => {
    expect(new Set([1, 2])).toEqual(new Set([1, 3]))
  })
  test('17 toEqual: equal valid dates', () => {
    expect(new Date(1000)).toEqual(new Date(1000))
  })
  test('18 toEqual: different valid dates', () => {
    expect(new Date(1000)).toEqual(new Date(2000))
  })
  test('19 toEqual: equal regular expressions', () => {
    expect(/a+b/gi).toEqual(/a+b/gi)
  })
  test('20 toEqual: regular expressions with different flags', () => {
    expect(/a+b/g).toEqual(/a+b/i)
  })
  test('21 toEqual: two errors of one class and message', () => {
    expect(new Error('same')).toEqual(new Error('same'))
  })
  test('22 toEqual: two errors with different messages', () => {
    expect(new Error('one')).toEqual(new Error('two'))
  })
  test('23 toEqual: NaN and NaN', () => {
    expect(Number.NaN).toEqual(Number.NaN)
  })
  test('24 toEqual: +0 and -0', () => {
    expect(0).toEqual(-0)
  })
  test('25 toEqual: an asymmetric matcher inside an object', () => {
    expect({ id: 5, name: 'n' }).toEqual({ id: expect.any(Number), name: 'n' })
  })
  test('26 addEqualityTesters: a tester applies inside nested values', () => {
    const tagOf = (value: unknown): unknown =>
      typeof value === 'object' && value !== null ? Reflect.get(value, '__tag') : undefined
    expect.addEqualityTesters([
      (a: unknown, b: unknown) =>
        tagOf(a) !== undefined && tagOf(b) !== undefined ? tagOf(a) === tagOf(b) : undefined,
    ])
    expect({ outer: { __tag: 'same', extra: 1 } }).toEqual({ outer: { __tag: 'same', extra: 2 } })
  })
})

describe('where they differ: errors and invalid dates', () => {
  test('27 toEqual: an Error and a TypeError with the same message', () => {
    expect(new Error('a')).toEqual(new TypeError('a'))
  })
  test('28 toEqual: errors with different causes', () => {
    expect(new Error('a', { cause: 'one' })).toEqual(new Error('a', { cause: 'two' }))
  })
  test('29 toEqual: an error with an extra own enumerable property', () => {
    expect(Object.assign(new Error('a'), { code: 'E_X' })).toEqual(new Error('a'))
  })
  test('30 toEqual: AggregateErrors with different errors', () => {
    expect(new AggregateError([new Error('x')], 'a')).toEqual(
      new AggregateError([new Error('y')], 'a'),
    )
  })
  test('31 toEqual: two different invalid dates', () => {
    expect(new Date('x')).toEqual(new Date('y'))
  })
})
