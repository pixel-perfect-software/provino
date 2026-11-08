jest.mock('./mocked.ts', () => ({ kind: 'mock' }))

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c(
  'isolateModules: a real module loads again inside, and the outer mock instance is visible',
  () => {
    const outerCounter = require('./counter.ts') as { loads: number }
    const outerMock = require('./mocked.ts')
    let innerCounter: { loads: number } | undefined
    let innerMock: unknown
    jest.isolateModules(() => {
      innerCounter = require('./counter.ts') as { loads: number }
      innerMock = require('./mocked.ts')
    })
    const outerAgain = require('./counter.ts') as { loads: number }
    return {
      outerLoads: outerCounter.loads,
      innerLoads: innerCounter?.loads,
      innerIsOuterCounter: innerCounter === outerCounter,
      outerStillCached: outerAgain === outerCounter,
      innerMockIsOuterMock: innerMock === outerMock,
    }
  },
)

c('nesting isolateModules throws', () => {
  let message = ''
  jest.isolateModules(() => {
    try {
      jest.isolateModules(() => undefined)
    } catch (error) {
      message = (error as Error).message
    }
  })
  return { message }
})
