describe('structures', () => {
  test('arrays', () => {
    expect([]).toMatchSnapshot()
    expect([1, [2, [3, [4]]]]).toMatchSnapshot()
    // biome-ignore lint/suspicious/noSparseArray: the hole is what this snapshot shows
    expect([1, , 3]).toMatchSnapshot()
    expect(new Array(2)).toMatchSnapshot()
    expect([undefined, null, 'x']).toMatchSnapshot()
  })

  test('objects', () => {
    expect({}).toMatchSnapshot()
    expect({ b: 1, a: { c: [1, { d: 2 }] } }).toMatchSnapshot()
    expect({ 'quoted key': 1, 2: 'two', plain: 3 }).toMatchSnapshot()
    expect(Object.create(null)).toMatchSnapshot()
    expect({ [Symbol('key')]: 1, visible: 2 }).toMatchSnapshot()
    expect({ a: undefined }).toMatchSnapshot()
  })

  test('collections', () => {
    expect(
      new Map([
        ['a', 1],
        [{ key: 1 }, new Set([1, 2])],
      ]),
    ).toMatchSnapshot()
    expect(new Set()).toMatchSnapshot()
    expect(new WeakMap()).toMatchSnapshot()
    expect(new Uint8Array([1, 2, 3])).toMatchSnapshot()
    expect(new Float32Array(0)).toMatchSnapshot()
  })

  test('class instances', () => {
    class Point {
      x = 1
      y = 2
    }
    class Named extends Point {
      label = 'n'
    }
    expect(new Point()).toMatchSnapshot()
    expect(new Named()).toMatchSnapshot()
    expect({ nested: new Point() }).toMatchSnapshot()
  })

  test('circular references', () => {
    const node: Record<string, unknown> = { name: 'node' }
    node.self = node
    node.list = [node, { again: node }]
    expect(node).toMatchSnapshot()
  })

  test('boxed values and deep nesting', () => {
    expect(new Number(1)).toMatchSnapshot()
    expect(new String('s')).toMatchSnapshot()
    expect(new Boolean(false)).toMatchSnapshot()
    expect({ l1: { l2: { l3: { l4: { l5: { l6: 'deep' } } } } } }).toMatchSnapshot()
  })
})
