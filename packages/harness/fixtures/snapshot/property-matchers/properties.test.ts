describe('property matchers', () => {
  test('merged into the snapshot', () => {
    expect({ id: 12345, name: 'n', when: new Date(86400000) }).toMatchSnapshot({
      id: expect.any(Number),
      when: expect.any(Date),
    })
  })

  test('with a hint', () => {
    expect({ token: 'abc123', kind: 'session' }).toMatchSnapshot(
      { token: expect.stringMatching(/^abc/) },
      'token hint',
    )
  })

  test('nested objects and arrays', () => {
    expect({ user: { id: 7, name: 'u' }, list: [{ n: 1, extra: 'x' }, { n: 2 }] }).toMatchSnapshot({
      user: { id: expect.any(Number) },
      list: [{ n: expect.any(Number) }, { n: 2 }],
    })
  })

  test('a plain value among them', () => {
    expect({ a: 1, b: 2 }).toMatchSnapshot({ a: 1 })
  })
})
