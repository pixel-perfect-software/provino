jest.mock('./target.ts', async () => ({ present: 'mock-present' }))

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('the exports of an async-factory module', () => {
  const target = require('./target.ts') as { present?: string; missing?: string }
  return { present: target.present, missing: target.missing }
})

c('the module is a thenable', () => {
  const target = require('./target.ts') as { then?: unknown }
  return { thenType: typeof target.then }
})
