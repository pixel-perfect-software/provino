test('inline snapshots', () => {
  expect({ a: 1, list: [1, 2] }).toMatchInlineSnapshot(`
    {
      "a": 1,
      "list": [
        1,
        2,
      ],
    }
  `)
  expect('x').toMatchInlineSnapshot(`"x"`)
})
