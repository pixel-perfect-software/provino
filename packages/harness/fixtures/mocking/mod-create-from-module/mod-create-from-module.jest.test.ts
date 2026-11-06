type Thing = { build: () => string | undefined; label: string }

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('createMockFromModule ignores the adjacent __mocks__ file and automocks the real module', () => {
  const made = jest.createMockFromModule<Thing>('./src/thing.ts')
  return { build: made.build(), buildIsMock: jest.isMockFunction(made.build), label: made.label }
})

c('requireMock of the same path returns the __mocks__ file', () => {
  const required = jest.requireMock<Thing>('./src/thing.ts')
  return {
    build: required.build(),
    buildIsMock: jest.isMockFunction(required.build),
    label: required.label,
  }
})

c('createMockFromModule makes a new object on every call', () => {
  const first = jest.createMockFromModule<Thing>('./src/thing.ts')
  const second = jest.createMockFromModule<Thing>('./src/thing.ts')
  return { same: first === second, sameFn: first.build === second.build }
})
