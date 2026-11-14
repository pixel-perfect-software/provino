describe('one', () => {
  test('o1', () => {})
  test('o2', () => {})
  test('o3', () => {})
  test('o4', () => {})
})
describe('two', () => {
  test('w1', () => {})
  test('w2', () => {})
  test('w3', () => {})
})
test('s1', () => {})
test('s2', () => {})
test('s3', () => {})
test('prints the seed', () => {
  console.log(`seed ${jest.getSeed()}`)
})
