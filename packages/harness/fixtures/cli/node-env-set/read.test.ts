// What NODE_ENV is as the file loads and inside a test: the titles hold what the file saw.
const atLoad = process.env.NODE_ENV

test(`NODE_ENV as the file loads: ${atLoad}`, () => {
  expect(atLoad).toBe('production')
})

test(`NODE_ENV inside a test: ${process.env.NODE_ENV}`, () => {
  expect(process.env.NODE_ENV).toBe('production')
})
