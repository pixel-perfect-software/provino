const myTest = test.extend({
  shared: [
    async ({ task: _task }, use) => {
      trace('worker setup')
      await use({ count: 0 })
    },
    { scope: 'worker' },
  ],
  perFile: [
    async ({ shared }, use) => {
      shared.count++
      trace(`file setup ${shared.count}`)
      await use(shared.count)
    },
    { scope: 'file' },
  ],
})

myTest('one', ({ shared, perFile }) => trace(`one ${shared.count} ${perFile}`))

myTest('two', ({ shared }) => trace(`two ${shared.count}`))

myTest('three', ({ perFile }) => trace(`three ${perFile}`))
