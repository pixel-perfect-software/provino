jest.mock('virtual-config', () => ({ level: 3 }), { virtual: true })

const optional = require('./optional.ts') as {
  optional: string
  virtual: () => { level: number }
}

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('a require of a missing module inside try/catch goes on, with its code', () => optional.optional)

c('a virtual mock required from the test file', () => require('virtual-config'))

c('a virtual mock required from a support file, when its require runs', () => optional.virtual())

c('a require of a missing module in a test throws then, not when the file loads', () => {
  try {
    require('still-not-installed')
    return 'loaded'
  } catch (error) {
    return { code: (error as { code?: string }).code }
  }
})
