// A shared helper module for the `locationFrame` tests: it registers a test from outside the test
// file, the way a project's `itBehavesLike(...)` helper would.
import type { RuntimeApi } from '../api.ts'

/** Registers a passing test named `name` from this file. */
export function registerFromHelper(api: RuntimeApi, name: string): void {
  api.test(name, () => {})
}

/** Registers a `beforeEach` from this file. */
export function registerHookFromHelper(api: RuntimeApi): void {
  api.beforeEach(() => {})
}
