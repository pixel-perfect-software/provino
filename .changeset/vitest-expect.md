---
"provino": patch
"@provino/expect": patch
"@provino/types": patch
"@provino/dialect-vitest": patch
"@provino/dialect-jest": patch
"@provino/snapshot": patch
---

The Vitest dialect has its own `expect`: `@vitest/expect` 5.0.5's matchers (aliases, sinon-chai's names, `toSatisfy` and `toBeOneOf` included) over Provino's front end, failing with Chai's `AssertionError` and Vitest's messages and diff, with Chai loaded only on a failure or a Chai assertion (`expect(x).to.equal(1)`), `expect(value, message)`, and equality that judges values from another realm by their class. `ExpectTable` gains `assertionError`, `messageArgument` and `chain` for it, and A Vitest failure carries Vitest's diff (`SerializedError.diff` is now that text, and the dialect's `core.shapeTestError` adds it where an error has none). `SnapshotPolicy.mismatch: 'throw'` makes a snapshot that differs throw at the call, as Vitest's does. `@provino/expect` exports `policyMessages`, the one copy of the words for its async and counting policies.
