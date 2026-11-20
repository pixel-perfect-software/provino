const myTest = test.extend({
  answer: 42,
  list: async ({ task: _task }, use) => {
    trace('list setup')
    await use([1, 2])
    trace('list teardown')
  },
  doubled: async ({ list }, use) => {
    trace('doubled setup')
    await use(list.map((n) => n * 2))
    trace('doubled teardown')
  },
})

myTest('reads a static value', ({ answer }) => {
  trace(`answer ${answer}`)
})

myTest('reads a fixture that reads another', ({ doubled }) => {
  trace(`doubled ${doubled.join(',')}`)
})

myTest('names no fixture', () => {
  trace('no fixtures')
})

myTest('changes its value', ({ list }) => {
  trace(`list ${list.join(',')}`)
  list.push(3)
})

myTest('gets a fresh value', ({ list }) => {
  trace(`list again ${list.join(',')}`)
})

test('the base test has no fixtures', (context) => {
  trace(`answer in the base test: ${String(context.answer)}`)
})
