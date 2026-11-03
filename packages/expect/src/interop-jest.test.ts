// Spike C, both ways, against Jest 30.5.2's own `expect` (T7.4). Its own process (`node --test`
// runs each file in one): Jest's `expect` defines the realm's slot when it loads, non-configurable,
// so our slot is never installed here, and our engine runs without one.
import { describe } from 'node:test'
import { expect as jestExpect } from 'expect'
import {
  defineInteropSuite,
  type InteropSubject,
  interopEngine,
  isFortyTwo,
  StartsWith,
  testEngine,
} from './internal/test-support.ts'

const jest = interopEngine(jestExpect)

describe('ours inside Jest`s expect', () => {
  const subjects: InteropSubject[] = [
    {
      name: 'a subclass of our base',
      matcher: new StartsWith('a'),
      good: 'ab',
      bad: 'ba',
      printed: 'StartsWith<a>',
    },
    {
      name: 'its inverse',
      matcher: new StartsWith('a', true),
      good: 'ba',
      bad: 'ab',
      printed: 'NotStartsWith<a>',
    },
    {
      name: 'a protocol-only object',
      matcher: isFortyTwo,
      good: 42,
      bad: 41,
      printed: 'IsFortyTwo',
    },
  ]
  defineInteropSuite(jest, subjects)
})

describe('Jest`s inside our expect', () => {
  const { expect } = testEngine()
  const ours = interopEngine(expect)
  jestExpect.extend({
    toBeEven: (received: number) => ({ pass: received % 2 === 0, message: () => '' }),
  })
  const toBeEven = (jestExpect as unknown as { toBeEven(): unknown }).toBeEven
  const subjects: InteropSubject[] = [
    { name: 'expect.any', matcher: jestExpect.any(Number), good: 1, bad: 'x' },
    { name: 'expect.anything', matcher: jestExpect.anything(), good: 0, bad: undefined },
    {
      name: 'expect.objectContaining',
      matcher: jestExpect.objectContaining({ a: 1 }),
      good: { a: 1, b: 2 },
      bad: { a: 2 },
    },
    {
      name: 'expect.not.objectContaining',
      matcher: jestExpect.not.objectContaining({ a: 1 }),
      good: { a: 2 },
      bad: { a: 1 },
    },
    {
      name: 'expect.arrayContaining',
      matcher: jestExpect.arrayContaining([1]),
      good: [1, 2],
      bad: [2],
    },
    {
      name: 'expect.arrayOf',
      matcher: jestExpect.arrayOf(jestExpect.any(Number)),
      good: [1, 2],
      bad: ['x'],
    },
    { name: 'expect.closeTo', matcher: jestExpect.closeTo(0.3, 5), good: 0.1 + 0.2, bad: 0.4 },
    {
      name: 'expect.stringMatching',
      matcher: jestExpect.stringMatching(/^a/),
      good: 'ab',
      bad: 'ba',
    },
    { name: 'a custom matcher`s asymmetric form', matcher: toBeEven(), good: 2, bad: 3 },
  ]
  defineInteropSuite(ours, subjects)
})
