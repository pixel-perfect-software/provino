// What every matcher returns, in one shape: a header naming the call, then a body.
import type { MatcherContext } from '@provino/expect'
import { diffLines, show } from './print.ts'

/** A matcher's `this`. */
export type Self = MatcherContext

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
): { pass: boolean; message: () => string; actual?: unknown; expected?: unknown } {
  return { pass, message: () => `${header(self, name, args)}\n\n${body()}`, ...values }
}

/** `Expected: …` and `Received: …`, with the difference below when there is one. */
export function expectedReceived(
  self: Self,
  expected: unknown,
  received: unknown,
  { label = 'Expected', withDiff = false }: { label?: string; withDiff?: boolean } = {},
): string {
  if (self.isNot) return `${label}: not ${show(expected)}\nReceived:     ${show(received)}`
  const lines = `${label}: ${show(expected)}\nReceived: ${show(received)}`
  const difference = withDiff ? diffLines(expected, received) : undefined
  return difference === undefined ? lines : `${lines}\n\n${difference}`
}
