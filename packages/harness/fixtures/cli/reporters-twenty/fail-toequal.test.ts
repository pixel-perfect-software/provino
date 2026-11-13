describe('toEqual', () => {
  it('fails with a diff', () => {
    expect({ name: 'a', list: [1, 2, 3], nested: { x: 1 } }).toEqual({
      name: 'b',
      list: [1, 2, 4],
      nested: { x: 1 },
    })
  })
})
