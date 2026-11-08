/**
 * The `lazy` slice, read by `@provino/lazy` (Track 6).
 * @public
 */
export interface LazyPolicy {
  /** Reading a test-scoped lazy variable in `beforeAll`. Jest: `error`. Vitest: `error`. research: track-01 L197 */
  readonly readInBeforeAll: 'error' | 'allow'
}
