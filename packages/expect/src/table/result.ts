// What every matcher returns, in one shape: a header naming the call, then a body.
import type { MatcherContext } from '@provino/expect'
import type { MatcherResult } from '@provino/types'
import { diffLines, show } from './print.ts'

/** A matcher's `this`. */
export type Self = MatcherContext

type Testers = NonNullable<Parameters<Self['equals']>[2]>

/** The user's equality testers, then `tail`: what a matcher hands `this.equals`. */
export const testersWith = (self: Self, ...tail: Testers): Testers => [
  ...self.customTesters,
  ...tail,
]

/** `expect(received).not.toBe(expected)`, the first line of every failure. */
const header = (self: Self, name: string, args: string): string =>
  `expect(received)${self.promise === undefined || self.promise === '' ? '' : `.${self.promise}`}${self.isNot ? '.not' : ''}.${name}(${args})`

/** A matcher result whose message is the header, a blank line and `body()`. */
export function result(
  self: Self,
  name: string,
  args: string,
  pass: boolean,
  body: () => string,
  values: { readonly actual?: unknown; readonly expected?: unknown } = {},
): MatcherResult {
  return { pass, message: () => `${header(self, name, args)}\n\n${body()}`, ...values }
}

/**
 * Two lines, `first: value` over `second: value`; under `.not` the first value is `not …` and the
 * second moves four columns right so the two values still line up.
 */
export const aligned = (
  self: Self,
  firstLabel: string,
  firstValue: string,
  secondLabel: string,
  secondValue: string,
): string =>
  self.isNot
    ? `${firstLabel}: not ${firstValue}\n${secondLabel}:     ${secondValue}`
    : `${firstLabel}: ${firstValue}\n${secondLabel}: ${secondValue}`

/** `Expected: …` and `Received: …`, with the difference below when there is one. */
export function expectedReceived(
  self: Self,
  expected: unknown,
  received: unknown,
  { label = 'Expected', withDiff = false }: { label?: string; withDiff?: boolean } = {},
): string {
  const lines = aligned(self, label, show(expected), 'Received', show(received))
  const difference = withDiff && !self.isNot ? diffLines(expected, received) : undefined
  return difference === undefined ? lines : `${lines}\n\n${difference}`
}
