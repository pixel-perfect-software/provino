const myTest = test.extend({
  value: 1,
})

myTest('not destructured', (context) => {
  trace(`never ${String(context.value)}`)
})

myTest('a rest element', ({ value, ...rest }) => {
  trace(`never ${value} ${Object.keys(rest).length}`)
})

myTest('destructured', ({ value }) => trace(`value ${value}`))

test('a base test with a plain parameter', (context) => trace(`base ${typeof context}`))
