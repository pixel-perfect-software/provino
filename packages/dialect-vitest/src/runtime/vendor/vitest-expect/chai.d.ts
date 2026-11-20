// provino: the `Chai` namespace the vendored files name in their types, as loose aliases. The
// package does not depend on `@types/chai`; Chai itself is loaded only when an assertion fails or a
// Chai assertion is used (`runtime/expect/chai.ts`).
declare namespace Chai {
  type Assertion = any
  type AssertionStatic = any
  type ChaiUtils = any
  type ChaiStatic = any
  type ExpectStatic = any
  type ChaiPlugin = any
}
