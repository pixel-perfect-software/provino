// One check per test: a status in the golden is Jest's verdict on it.
import { value as early } from './dep.ts'

test('setMock replaces the module for later requires and returns jest', () => {
  const result = jest.setMock('./dep.ts', { value: 'mock' })
  expect(result).toBe(jest)
  expect(require('./dep.ts').value).toBe('mock')
})
test('a binding imported before setMock keeps the real module', () => {
  expect(early).toBe('real')
})
test('requireActual still gives the real module after setMock', () => {
  expect(jest.requireActual('./dep.ts').value).toBe('real')
})
test('mocked is the identity', () => {
  const fn = jest.fn()
  expect(jest.mocked(fn)).toBe(fn)
  const plain = { a: 1 }
  expect(jest.mocked(plain)).toBe(plain)
})
test('getSeed is an integer, the same on every call', () => {
  expect(Number.isInteger(jest.getSeed())).toBe(true)
  expect(jest.getSeed()).toBe(jest.getSeed())
})
test('isEnvironmentTornDown is false while a test runs', () => {
  expect(jest.isEnvironmentTornDown()).toBe(false)
})
test('setTimeout returns jest', () => {
  expect(jest.setTimeout(5000)).toBe(jest)
})
test('autoMockOn and autoMockOff return jest, and are the enable and disable calls', () => {
  expect(jest.autoMockOn()).toBe(jest)
  expect(jest.autoMockOff()).toBe(jest)
  expect(jest.enableAutomock()).toBe(jest)
  expect(jest.disableAutomock()).toBe(jest)
})
test('onGenerateMock returns jest', () => {
  expect(jest.onGenerateMock((_name: string, mock: unknown) => mock)).toBe(jest)
})
test('onGenerateMock sees the module path, resolved, and can replace the generated mock', () => {
  const seen: string[] = []
  jest.onGenerateMock((name: string, mock: unknown) => {
    seen.push(name)
    return { replaced: true, original: mock }
  })
  const made = jest.createMockFromModule('./dep.ts') as { replaced?: boolean }
  expect(seen).toHaveLength(1)
  expect(seen[0]).toBe(require.resolve('./dep.ts'))
  expect(made.replaced).toBe(true)
})
test('unstable_mockModule needs a factory', () => {
  expect(() => (jest.unstable_mockModule as (name: string) => unknown)('./dep.ts')).toThrow(
    '`unstable_mockModule` must be passed a mock factory',
  )
})
test('the members are all functions', () => {
  for (const key of [
    'setMock',
    'deepUnmock',
    'mocked',
    'getSeed',
    'isEnvironmentTornDown',
    'setTimeout',
    'retryTimes',
    'autoMockOn',
    'autoMockOff',
    'onGenerateMock',
    'unstable_mockModule',
    'unstable_unmockModule',
    'isolateModules',
    'isolateModulesAsync',
    'requireActual',
    'requireMock',
    'createMockFromModule',
    'replaceProperty',
  ]) {
    expect(typeof (jest as unknown as Record<string, unknown>)[key]).toBe('function')
  }
})
