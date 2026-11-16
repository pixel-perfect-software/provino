// Inline snapshot matchers called from inside other matchers. Where a snapshot is written is the
// frame below the innermost matcher call: jest-snapshot cuts its stack at the innermost
// external-matcher trap (`removeLinesBeforeExternalMatcherTrap`), and Jest registers its own
// snapshot matchers with `expect.extend`, so they run inside a trap too. A matcher called through
// `expect` inside another custom matcher therefore writes into that matcher's body, here.
import { toMatchInlineSnapshot } from 'jest-snapshot'

const passed = { pass: true, message: () => '' }

expect.extend({
  // https://jestjs.io/docs/snapshot-testing#custom-inline-snapshot-matchers
  toMatchTrimmedInlineSnapshot(received, ...rest) {
    return toMatchInlineSnapshot.call(this, received.substring(0, 10), ...rest)
  },
  // A custom matcher over the one above, through `expect`.
  toMatchShoutedInlineSnapshot(received) {
    expect(received.toUpperCase()).toMatchTrimmedInlineSnapshot()
    return passed
  },
  // The built-in inline matcher inside a custom matcher.
  toMatchBuiltInInlineSnapshot(received) {
    expect(received).toMatchInlineSnapshot()
    return passed
  },
  // Another custom matcher over the built-in one, called from the matcher below.
  toMatchInnerBuiltInInlineSnapshot(received) {
    expect(received).toMatchInlineSnapshot()
    return passed
  },
  // The built-in two custom matchers down.
  toMatchNestedBuiltInInlineSnapshot(received) {
    expect(`${received}!`).toMatchInnerBuiltInInlineSnapshot()
    return passed
  },
})
