jest.mock('./dep.ts')

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('requiring an automocked module with no metadata', () => {
  try {
    return { loaded: typeof require('./dep.ts') }
  } catch (error) {
    return {
      threw: { message: String((error as Error).message).replaceAll(__dirname, '<root>') },
    }
  }
})
