---
"provino": patch
"@provino/dialect-jest": patch
"@provino/types": patch
---

`provino jest` prints a failed `node:assert` call as Jest 30.5.2 does. A test that fails with `assert.equal`, `strictEqual`, `deepStrictEqual`, `ok`, `notEqual`, `throws`, `doesNotThrow`, `match`, `rejects` or `fail` reads `assert.equal(received, expected)`, `Expected value to be equal to:`, the received value and a diff (jest-circus's `formatNodeAssertErrors`), where Provino printed Node's `AssertionError [ERR_ASSERTION]: …`; `failureMessages` and `failureDetails` in `--json` follow. The policy gains `core.shapeTestError` (`ShapeTestError`), a behaviour that replaces the error of a failed test before it is reported; the Jest dialect sets it, the neutral policy leaves it `null`.
