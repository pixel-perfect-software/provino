const helper = require('./helper.ts') as { seen: { who: string; greeting: string } }
const dep = require('./dep.ts') as { who: string }

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('require() of an ESM helper that mocks and imports loads it synchronously', () => ({
  seen: helper.seen,
  loads: (globalThis as { __helperLoads?: number }).__helperLoads,
}))

c("the helper's mock applies to the test file too", () => dep.who)

c('inside isolateModules the helper loads again, synchronously, and still sees the mock', () => {
  let isolated: { seen: { who: string } } | undefined
  jest.isolateModules(() => {
    isolated = require('./helper.ts') as { seen: { who: string } }
  })
  return {
    who: isolated?.seen.who,
    loads: (globalThis as { __helperLoads?: number }).__helperLoads,
  }
})
