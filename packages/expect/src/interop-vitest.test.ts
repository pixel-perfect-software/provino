// Spike C, both ways, against Vitest 5.0.5's `@vitest/expect` (T7.4). Its own process: loading
// `@vitest/expect` defines the realm's slot, so our slot is never installed here. Vitest's expect
// is assembled as Vitest assembles it: Chai with the Jest plugins.
import { describe, test } from 'node:test'
import {
  Any,
  Anything,
  ArrayContaining,
  chai,
  JestAsymmetricMatchers,
  JestChaiExpect,
  JestExtend,
  ObjectContaining,
  StringContaining,
  StringMatching,
} from '@vitest/expect'
import {
  type InteropEngine,
  type InteropSubject,
  interopCases,
  isFortyTwo,
  StartsWith,
  testEngine,
} from './internal/test-support.ts'

chai.use(JestExtend)
chai.use(JestChaiExpect)
chai.use(JestAsymmetricMatchers)

/** What the Jest plugins add to a Chai assertion; Chai's own types don't list them. */
interface JestOnChai {
  toEqual(expected: unknown): void
  toMatchObject(expected: object): void
  readonly not: { toEqual(expected: unknown): void }
}

const vexpect = (received: unknown): JestOnChai => chai.expect(received) as unknown as JestOnChai

const vitest: InteropEngine = {
  toEqual: (received, expected) => vexpect(received).toEqual(expected),
  notToEqual: (received, expected) => vexpect(received).not.toEqual(expected),
  toMatchObject: (received, expected) => vexpect(received).toMatchObject(expected),
}

describe('ours inside Vitest`s expect', () => {
  // Vitest's one-line message truncates the expected value (`{ a: { …(3) } }`), so `printed`
  // isn't checked here.
  const subjects: InteropSubject[] = [
    { name: 'a subclass of our base', matcher: new StartsWith('a'), good: 'ab', bad: 'ba' },
    { name: 'its inverse', matcher: new StartsWith('a', true), good: 'ba', bad: 'ab' },
    { name: 'a protocol-only object', matcher: isFortyTwo, good: 42, bad: 41 },
  ]
  for (const subject of subjects) {
    describe(subject.name, () => {
      for (const [name, run] of interopCases(vitest, subject)) test(name, run)
    })
  }
})

describe('Vitest`s inside our expect', () => {
  const { expect } = testEngine()
  const ours: InteropEngine = {
    toEqual: (received, expected) => expect(received).toEqual(expected),
    notToEqual: (received, expected) => expect(received).not.toEqual(expected),
    toMatchObject: (received, expected) => expect(received).toMatchObject(expected),
  }
  const subjects: InteropSubject[] = [
    { name: 'Any', matcher: new Any(Number), good: 1, bad: 'x' },
    { name: 'Anything', matcher: new Anything(), good: 0, bad: undefined },
    {
      name: 'ObjectContaining',
      matcher: new ObjectContaining({ a: 1 }),
      good: { a: 1, b: 2 },
      bad: { a: 2 },
    },
    {
      name: 'ObjectContaining, inverse',
      matcher: new ObjectContaining({ a: 1 }, true),
      good: { a: 2 },
      bad: { a: 1 },
    },
    { name: 'ArrayContaining', matcher: new ArrayContaining([1]), good: [1, 2], bad: [2] },
    { name: 'StringContaining', matcher: new StringContaining('b'), good: 'ab', bad: 'ac' },
    { name: 'StringMatching', matcher: new StringMatching(/^a/), good: 'ab', bad: 'ba' },
  ]
  for (const subject of subjects) {
    describe(subject.name, () => {
      for (const [name, run] of interopCases(ours, subject)) test(name, run)
    })
  }
})
