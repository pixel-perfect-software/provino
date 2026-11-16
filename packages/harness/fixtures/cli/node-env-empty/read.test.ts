const atLoad = process.env.NODE_ENV

test(`NODE_ENV as the file loads: ${JSON.stringify(atLoad)}`, () => {
  expect(atLoad).toBe('')
})

test(`NODE_ENV inside a test: ${JSON.stringify(process.env.NODE_ENV)}`, () => {
  expect(process.env.NODE_ENV).toBe('')
})
