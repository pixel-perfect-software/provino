test.each([[1, 2]])('array row, done declared %i', (a, b, done) => {
  trace(`array row: ${a} ${b} ${typeof done}`)
  done()
})

test.each([[1, 2]])('array row, no done %i', (a, b) => {
  trace(`array row, no done: ${a} ${b}`)
})

test.each([1, 2])('primitive rows, done declared %i', (a, done) => {
  trace(`primitive row: ${a} ${typeof done}`)
  done()
})

test.each([[1, 2]])('array row, rest parameter %i', (...args) => {
  trace(`rest: ${args.length} arguments`)
})

test.each([[1, 2, 3]])('array row that fills the parameters %i', (a, b, c) => {
  trace(`filled: ${a} ${b} ${c}`)
})

describe.each([[1]])('describe row %i', (n) => {
  test('inside', () => trace(`describe row: ${n}`))
})
