# @provino/expect

## 0.1.0-rc.11

### Patch Changes

- bb82b45: A native project takes `expect(value, message)` and `expect.soft(value, message)`: the message is the first line of a failure, then a blank line, then the matcher's text with the measured values. A third argument is refused as "expect() takes a value and an optional message".
- Updated dependencies [514f338]
- Updated dependencies [bb82b45]
- Updated dependencies [8660a21]
- Updated dependencies [cfb5974]
  - @provino/types@0.1.0-rc.11
  - @provino/snapshot@0.1.0-rc.11

## 0.1.0-rc.10

### Patch Changes

- Updated dependencies [43cab28]
- Updated dependencies [921fde7]
  - @provino/types@0.1.0-rc.10
  - @provino/snapshot@0.1.0-rc.10

## 0.1.0-rc.9

### Patch Changes

- Updated dependencies [6e68b21]
- Updated dependencies [6e68b21]
  - @provino/types@0.1.0-rc.9
  - @provino/snapshot@0.1.0-rc.9

## 0.1.0-rc.8

### Patch Changes

- Updated dependencies [4534450]
  - @provino/types@0.1.0-rc.8
  - @provino/snapshot@0.1.0-rc.8

## 0.1.0-rc.7

### Minor Changes

- c730222: `@provino/expect` no longer depends on `@jest/expect-utils`: its `equals` and testers are vendored from 30.5.2 and re-exported (`equals`, `iterableEquality`, `subsetEquality`, `typeEquality`, `sparseArrayEquality`, `arrayBufferEquality`, `getPath`). `@provino/expect/table` now builds `provinoExpectTable()`, Provino's own matcher table for a project with no dialect (34 matchers, with `toBeTypeOf`, `toSatisfy` and the three `toHaveReturned*` forms now typed in `Matchers`, 7 asymmetric matchers, values through `util.inspect`, differences through `util.diff`).

### Patch Changes

- ce31acb: Error and help messages no longer name internal task ids. A non-empty `plugins` or `alsoServe` says `config key "plugins" isn't supported yet`; `provino --help` no longer says that a build loads the Jest dialect's code or points at the task that builds a refused flag; and the "not implemented yet", "not supported yet" and "not applied" texts of `provino run`, `provino jest` and `provino vitest`, the loader, the environments, core, the orchestrator, coverage, the transform and the inline snapshot matchers drop their task and decision references.
- c2970a6: The Vitest dialect has its own `expect`: `@vitest/expect` 5.0.5's matchers (aliases, sinon-chai's names, `toSatisfy` and `toBeOneOf` included) over Provino's front end, failing with Chai's `AssertionError` and Vitest's messages and diff, with Chai loaded only on a failure or a Chai assertion (`expect(x).to.equal(1)`), `expect(value, message)`, and equality that judges values from another realm by their class. `ExpectTable` gains `assertionError`, `chain` and `equals` for it, its `messages` may leave the engine's own policy words out (`ExpectTableMessages`), `ExpectPolicy` gains `settlementCheck` and `messageArgument`, and A Vitest failure carries Vitest's diff (`SerializedError.diff` is now that text, and the dialect's `core.shapeTestError` adds it where an error has none). `SnapshotPolicy.mismatch: 'throw'` makes a snapshot that differs throw at the call, as Vitest's does. `@provino/expect` exports `policyMessages`, the one copy of the words for its async and counting policies.
- Updated dependencies [28c95d9]
- Updated dependencies [5a4dce2]
- Updated dependencies [9f7b73d]
- Updated dependencies [7daea04]
- Updated dependencies [c730222]
- Updated dependencies [ba5e5f7]
- Updated dependencies [ecc8972]
- Updated dependencies [55de21e]
- Updated dependencies [c2970a6]
  - @provino/types@0.1.0-rc.7
  - @provino/snapshot@0.1.0-rc.7

## 0.1.0-rc.6

### Patch Changes

- @provino/snapshot@0.1.0-rc.6
  - @provino/types@0.1.0-rc.6

## 0.1.0-rc.5

### Patch Changes

- @provino/snapshot@0.1.0-rc.5
  - @provino/types@0.1.0-rc.5

## 0.1.0-rc.4

### Patch Changes

- @provino/snapshot@0.1.0-rc.4
  - @provino/types@0.1.0-rc.4

## 0.1.0-rc.3

### Patch Changes

- @provino/snapshot@0.1.0-rc.3
  - @provino/types@0.1.0-rc.3

## 0.1.0-rc.2

### Patch Changes

- Updated dependencies [d015c8e]
  - @provino/types@0.1.0-rc.2
  - @provino/snapshot@0.1.0-rc.2

## 0.1.0-rc.1

### Patch Changes

- @provino/snapshot@0.1.0-rc.1
  - @provino/types@0.1.0-rc.1

## 0.1.0-rc.0

### Patch Changes

- Updated dependencies [063753f]
- Updated dependencies [dbe800f]
- Updated dependencies [e79a080]
- Updated dependencies [f6e0ab6]
- Updated dependencies [73dbb1b]
- Updated dependencies [983f094]
- Updated dependencies [0b12a9f]
- Updated dependencies [7c3711a]
- Updated dependencies [4feaef4]
- Updated dependencies [a9571da]
- Updated dependencies [26ed357]
- Updated dependencies [26ed357]
- Updated dependencies [ddb10bf]
- Updated dependencies [646c3e3]
- Updated dependencies [646c3e3]
- Updated dependencies [475232b]
- Updated dependencies [5ec4d3b]
- Updated dependencies [209f097]
- Updated dependencies [3872fb2]
- Updated dependencies [14850e9]
- Updated dependencies [c5230cd]
- Updated dependencies [493ebff]
- Updated dependencies [929e910]
- Updated dependencies [09fc2b2]
- Updated dependencies [a43cb01]
- Updated dependencies [f7a629d]
- Updated dependencies [f7a629d]
- Updated dependencies [a602762]
- Updated dependencies [dd8b08f]
- Updated dependencies [cffb867]
- Updated dependencies [9a55f65]
- Updated dependencies [2da1a4b]
- Updated dependencies [d464f91]
- Updated dependencies [133727f]
- Updated dependencies [a56ca80]
- Updated dependencies [3872fb2]
- Updated dependencies [6186141]
- Updated dependencies [fe9ad4f]
- Updated dependencies [a2764b2]
- Updated dependencies [1f0842e]
- Updated dependencies [3a87631]
- Updated dependencies [d3d0649]
- Updated dependencies [26ed357]
- Updated dependencies [4f255d8]
- Updated dependencies [a21fdff]
  - @provino/types@0.1.0-rc.0
  - @provino/snapshot@0.1.0-rc.0
