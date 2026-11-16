test(`NODE_ENV in the second file: ${JSON.stringify(process.env.NODE_ENV)}`, () => {
  expect(process.env.NODE_ENV).toBe('')
})
