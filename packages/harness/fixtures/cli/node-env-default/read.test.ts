// What NODE_ENV is as the file loads and inside a test: the titles hold what the file saw.
const atLoad = process.env.NODE_ENV

test(`NODE_ENV as the file loads: ${atLoad}`, () => {
  expect(atLoad).toBe('test')
})

test(`NODE_ENV is an own property of process.env: ${Object.hasOwn(process.env, 'NODE_ENV')}`, () => {
  expect(process.env.NODE_ENV).toBe('test')
  expect(Object.hasOwn(process.env, 'NODE_ENV')).toBe(true)
})
