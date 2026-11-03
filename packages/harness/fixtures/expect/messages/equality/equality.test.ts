class Point {
  readonly x: number
  readonly y: number

  constructor(x: number, y: number) {
    this.x = x
    this.y = y
  }
}

// Twenty keys with one different in the middle, so the diff has unchanged lines to collapse.
const wide = (middle: number): Record<string, number> => {
  const out: Record<string, number> = {}
  for (let i = 0; i < 20; i++) out[`key${String(i).padStart(2, '0')}`] = i === 10 ? middle : i
  return out
}

describe('toBe', () => {
  test('toBe number labels Expected and Received', () => {
    expect(1).toBe(2)
  })

  test('toBe string shows both quoted', () => {
    expect('apple').toBe('apples')
  })

  test('toBe null against undefined', () => {
    expect(null).toBe(undefined)
  })

  test('toBe equal objects hints toStrictEqual', () => {
    expect({ a: 1, b: [2] }).toBe({ a: 1, b: [2] })
  })

  test('toBe objects equal only loosely hints toEqual', () => {
    expect({ a: 1, b: undefined }).toBe({ a: 1 })
  })

  test('toBe -0 against 0', () => {
    expect(-0).toBe(0)
  })

  test('not.toBe the same number', () => {
    expect(3).not.toBe(3)
  })
})

describe('toEqual', () => {
  test('toEqual object diff shows Object { prefix', () => {
    expect({ a: 1, b: 2 }).toEqual({ a: 1, b: 3 })
  })

  test('toEqual array diff shows Array [ prefix', () => {
    expect([1, 2, 3]).toEqual([1, 2, 4])
  })

  test('toEqual nested object diff', () => {
    expect({ user: { name: 'ada', tags: ['x'] } }).toEqual({ user: { name: 'bob', tags: ['x'] } })
  })

  test('toEqual Map diff', () => {
    expect(
      new Map([
        ['a', 1],
        ['b', 2],
      ]),
    ).toEqual(
      new Map([
        ['a', 1],
        ['b', 3],
      ]),
    )
  })

  test('toEqual Set diff', () => {
    expect(new Set([1, 2])).toEqual(new Set([1, 3]))
  })

  test('toEqual long diff collapses into @@ hunks', () => {
    expect(wide(10)).toEqual(wide(99))
  })

  test('toEqual different types', () => {
    expect('1').toEqual(1)
  })

  test('not.toEqual equal objects', () => {
    expect({ a: 1 }).not.toEqual({ a: 1 })
  })
})

describe('toStrictEqual', () => {
  test('toStrictEqual class instance against literal', () => {
    expect(new Point(1, 2)).toStrictEqual({ x: 1, y: 2 })
  })

  test('toStrictEqual undefined property against missing', () => {
    expect({ a: 1, b: undefined }).toStrictEqual({ a: 1 })
  })

  test('toStrictEqual sparse array against undefined item', () => {
    // biome-ignore lint/suspicious/noSparseArray: the hole is the case under test.
    expect([1, , 3]).toStrictEqual([1, undefined, 3])
  })

  test('not.toStrictEqual identical arrays', () => {
    expect([1, 2]).not.toStrictEqual([1, 2])
  })
})

describe('after passing assertions', () => {
  test('two passing toBe then a failing toEqual', () => {
    expect(1).toBe(1)
    expect('a').toBe('a')
    expect({ x: 1 }).toEqual({ x: 2 })
  })

  test('one passing toEqual then a failing toBe', () => {
    expect([1]).toEqual([1])
    expect(true).toBe(false)
  })

  test('one passing toStrictEqual then a failing not.toBe', () => {
    expect({ k: 'v' }).toStrictEqual({ k: 'v' })
    expect('same').not.toBe('same')
  })
})
