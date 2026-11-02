/**
 * A step of the mock cleanup that runs between tests.
 * @public
 */
export type MockCleanupStep = 'clear' | 'reset' | 'restore' | 'unstubEnvs' | 'unstubGlobals'

/**
 * Error texts a mock engine prints, by message code. Track 4 (B13a) defines the codes.
 * @public
 */
export interface MockMessages {
  readonly [code: string]: string
}

/**
 * The `mock` slice, read by `@provino/mock` (Track 4): mock functions, spies and cleanup.
 * Track 4's `MockPolicy` and `MockCleanupPolicy`, merged under Track 1's names.
 * @public
 */
export interface MockPolicy {
  /**
   * What `mockReset` restores the implementation to. Also Track 4's `resetTarget` and Track 11's
   * `mockReset`. Jest: `empty`. Vitest: `original-impl`. unverified: track-01 L198, track-04 L256
   */
  readonly resetTo: 'empty' | 'original-impl'
  /** Default mock name. Also Track 4's `defaultMockName`. Jest: `'jest.fn()'`. Vitest: `'vi.fn()'`. unverified: track-01 L199, track-04 L253 */
  readonly defaultName: string
  /**
   * Cleanup between tests: the order of the steps, and which run by default. Also Track 4's
   * `MockCleanupPolicy` and Track 11's `clearMocksDefault` (= `clear`).
   * Jest: order clear, reset, restore; all `false`.
   * Vitest: order restore, reset, clear, unstubEnvs, unstubGlobals; `clear` `true`, the rest `false`.
   * unverified: track-01 L200, track-04 L275
   */
  readonly between: {
    readonly order: readonly MockCleanupStep[]
    readonly clear: boolean
    readonly reset: boolean
    readonly restore: boolean
    readonly unstubEnvs: boolean
    readonly unstubGlobals: boolean
  }
  /**
   * The prototype of a mocked class's instances. Also Track 4's `chainPrototype`.
   * Jest: `own`. Vitest: `chain-to-impl`. unverified: track-01 L201, track-04 L261
   */
  readonly classMockPrototype: 'own' | 'chain-to-impl'
  /** Whether a spy is named after the spied method. Jest: `false`. Vitest: `true`. unverified: track-04 L254 */
  readonly spyNameFromMethod: boolean
  /** The mock function's own `name`. Jest: `mockConstructor`. Vitest: `impl-or-Mock`. unverified: track-04 L255 */
  readonly functionName: 'mockConstructor' | 'impl-or-Mock'
  /** What `new mock()` does. Values: Track 4 gives the union only; B14 records them. unverified: track-04 L257 */
  readonly newCall: 'apply' | 'construct'
  /** Whether `mockReturnValue`-style shorthands throw when the mock is called with `new`. Jest: `false`. Vitest: `true`. unverified: track-04 L258 */
  readonly valueShorthandsThrowOnNew: boolean
  /** Whether `fn(mock)` returns the same mock. Jest: `false`. Vitest: `true`. unverified: track-04 L259 */
  readonly fnOfMockReturnsSame: boolean
  /** Whether a mock copies its implementation's static properties. Jest: `false`. Vitest: `true`. unverified: track-04 L260 */
  readonly copyStaticProps: boolean
  /** Whether `mock.settledResults` exists. Jest: `false`. Vitest: `true`. unverified: track-04 L262 */
  readonly settledResults: boolean
  /** When `mock.lastCall` exists as a key. Jest: `after-first-call`. Vitest: `always`. unverified: track-04 L263 */
  readonly lastCallKey: 'after-first-call' | 'always'
  /** Whether `mockClear` replaces the `mock` state object rather than emptying it. Jest: `true`. Vitest: `false`. unverified: track-04 L264 */
  readonly clearReplacesStateObject: boolean
  /** Whether the `mock` property is writable. Jest: `true`. Vitest: `false`. unverified: track-04 L265 */
  readonly mockPropertyWritable: boolean
  /** Whether `withImplementation` returns the mock. Jest: `false`. Vitest: `true`. unverified: track-04 L266 */
  readonly withImplementationReturnsMock: boolean
  /** Whether `getMockImplementation` prefers a pending `mockImplementationOnce`. Jest: `false`. Vitest: `true`. unverified: track-04 L267 */
  readonly getImplPrefersOnce: boolean
  /** Whether a spy reports its bridging implementation. Jest: `true`. Vitest: `false`. unverified: track-04 L268 */
  readonly spyReportsBridgeImpl: boolean
  /** Whether `isMockFunction` accepts objects. Jest: `true`. Vitest: `false`. unverified: track-04 L269 */
  readonly isMockAcceptsObjects: boolean
  /** How `spyOn` installs a spy. Jest: `assign`. Vitest: `define`. unverified: track-04 L270 */
  readonly spyInstall: 'assign' | 'define'
  /** Error texts per message code. unverified: track-04 L271 */
  readonly messages: MockMessages
}
