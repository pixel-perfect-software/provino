describe('snapshotFormat', () => {
  test('options', () => {
    class Box {
      value = 1
    }
    expect({ a: 'q"uote\\', list: [1, { b: [2, [3]] }] }).toMatchSnapshot()
    expect(new Box()).toMatchSnapshot()
    expect({ l1: { l2: { l3: { l4: 1 } } } }).toMatchSnapshot()
    expect(new Map([['k', { v: 1 }]])).toMatchSnapshot()
  })
})
