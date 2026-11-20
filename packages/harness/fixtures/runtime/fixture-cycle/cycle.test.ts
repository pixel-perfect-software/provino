const myTest = test.extend({
  ping: async ({ pong }, use) => {
    await use(`ping ${pong}`)
  },
  pong: async ({ ping }, use) => {
    await use(`pong ${ping}`)
  },
  noUse: async ({ task: _task }, _use) => {
    trace('noUse returns')
  },
  fine: 1,
})

myTest('a cycle', ({ ping }) => {
  trace(`never ${ping}`)
})

myTest('use is never called', ({ noUse }) => {
  trace(`never ${noUse}`)
})

myTest('a test with a fine fixture', ({ fine }) => trace(`fine ${fine}`))
