// One check per test: a status in the golden is Jest's verdict on it.
import * as facade from '@jest/globals'
import { describe as gDescribe, expect as gExpect, it as gIt, jest as gJest } from '@jest/globals'

test('expect is the injected expect', () => {
  expect(gExpect).toBe(expect)
})
test('describe and it are the injected ones', () => {
  expect(gDescribe).toBe(describe)
  expect(gIt).toBe(it)
})
test('the facade has the fourteen globals', () => {
  expect(
    Object.keys(facade)
      .filter((key) => key !== 'default')
      .sort(),
  ).toEqual([
    'afterAll',
    'afterEach',
    'beforeAll',
    'beforeEach',
    'describe',
    'expect',
    'fdescribe',
    'fit',
    'it',
    'jest',
    'test',
    'xdescribe',
    'xit',
    'xtest',
  ])
})
test('jest from the facade is the injected jest', () => {
  expect(gJest).toBe(jest)
})
test('jest from the facade has the module-mock members', () => {
  expect(typeof gJest.mock).toBe('function')
  expect(typeof gJest.requireActual).toBe('function')
  expect(typeof gJest.createMockFromModule).toBe('function')
})
test('jest.fn through the facade is a mock function', () => {
  const fn = gJest.fn(() => 3)
  expect(fn()).toBe(3)
  expect(gJest.isMockFunction(fn)).toBe(true)
})
test('the matcher registry is on the global symbol', () => {
  const registry = (globalThis as Record<symbol, unknown>)[Symbol.for('$$jest-matchers-object')]
  expect(typeof registry).toBe('object')
})
test('the facade is the same object when required again', () => {
  expect(require('@jest/globals').expect).toBe(gExpect)
})
