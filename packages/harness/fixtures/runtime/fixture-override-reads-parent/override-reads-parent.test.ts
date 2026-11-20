const myTest = test.extend({
  user: async ({ task: _task }, use) => {
    trace('base user')
    await use({ name: 'base' })
  },
  greeting: async ({ user }, use) => {
    await use(`hello ${user.name}`)
  },
})

myTest('base', ({ greeting }) => trace(greeting))

describe('overridden', () => {
  myTest.override({
    user: async ({ user }, use) => {
      trace(`override reads ${user.name}`)
      await use({ name: `${user.name}+override` })
    },
  })

  myTest('a dependent sees the override', ({ greeting }) => trace(greeting))

  describe('nested', () => {
    myTest('inherits the override', ({ user }) => trace(`nested ${user.name}`))
  })
})

describe('builder override', () => {
  myTest.override('user', ({ user }) => ({ name: `${user.name}!` }))
  myTest('builder', ({ user }) => trace(`builder ${user.name}`))
})

describe('static override', () => {
  myTest.override({ user: { name: 'static' } })
  myTest('static', ({ greeting }) => trace(greeting))
})

myTest('after the blocks, the base again', ({ greeting }) => trace(greeting))
