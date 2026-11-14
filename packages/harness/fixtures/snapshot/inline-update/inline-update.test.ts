test('rewrites what differs', () => {
  expect({ a: 2 }).toMatchInlineSnapshot(`
    {
      "a": 1,
    }
  `)
  expect('new').toMatchInlineSnapshot('"old"')
  expect('same').toMatchInlineSnapshot(`"same"`)
  expect(() => {
    throw new Error('now')
  }).toThrowErrorMatchingInlineSnapshot(`"before"`)
})

test('keeps what matches', () => {
  expect([1]).toMatchInlineSnapshot(`
    [
      1,
    ]
  `)
})
