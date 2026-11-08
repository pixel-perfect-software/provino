import lib from 'cjs-lib'

vi.mock('cjs-lib')

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('a CommonJS package: functions become mocks that return undefined', () => ({
  result: lib.greet('x'),
  isMock: vi.isMockFunction(lib.greet),
  calls: (lib.greet as unknown as { mock: { calls: unknown[] } }).mock.calls,
}))

c('a CommonJS package: nested methods are mocks and values are kept', () => ({
  hello: lib.config.hello(),
  helloIsMock: vi.isMockFunction(lib.config.hello),
  level: lib.config.level,
  version: lib.VERSION,
  keys: Object.keys(lib),
}))
