import type { Behaviour } from './behaviour.ts'

/**
 * Builds a snapshot's key from the test's full name and its 1-based count in that test.
 * @public
 */
export type SnapshotKey = (fullName: string, count: number) => string

/**
 * Resolves a test file's snapshot file path.
 * @public
 */
export type ResolveSnapshotPath = (testPath: string, extension: string) => string

/**
 * The `snapshot` slice, read by `@provino/snapshot` (Track 7).
 * @public
 */
export interface SnapshotPolicy {
  /**
   * First line of a `.snap` file. Jest: `// Jest Snapshot v1, https://jestjs.io/docs/snapshot-testing`.
   * Vitest: `// Vitest Snapshot v1, https://vitest.dev/guide/snapshot.html`.
   * research: track-01 L215, track-07 L468, track-11 L520
   */
  readonly header: string
  /** Builds snapshot keys. Jest: `` `${name} ${n}` ``. Vitest: the same. research: track-01 L216 */
  readonly key: Behaviour<SnapshotKey>
  /** Joins name parts inside a snapshot key. Jest: `' '`. Vitest: `' > '`. research: track-07 L469 */
  readonly keyJoin: string
  /** Joins a snapshot hint to its name. Jest: `': '`. Vitest: `' > '`. research: track-07 L469 */
  readonly hintJoin: string
  /** Snapshot directory name. Jest: `__snapshots__`. Vitest: the same. research: track-01 L217 */
  readonly dirName: string
  /** Snapshot file extension. Jest: `.snap`. Vitest: the same. research: track-01 L217 */
  readonly extension: string
  /**
   * pretty-format options for snapshots. Track 7 adds `maxOutputLength` (`null` = unlimited).
   * Jest: `escapeString` `false`, `printBasicPrototype` `false`, no limit.
   * Vitest: the same, `maxOutputLength` 2**27. research: track-01 L218, track-07 L474
   */
  readonly format: {
    readonly escapeString: boolean
    readonly printBasicPrototype: boolean
    readonly maxOutputLength: number | null
  }
  /** Snapshot serializer modules, each with a default-exported pretty-format plugin. Jest: user list. Vitest: user list. research: track-01 L219 */
  readonly serializers: readonly string[]
  /**
   * Whether obsolete snapshots fail the run, locally and in CI. Track 1 lists `report` for both;
   * Track 7's detail is used. Jest: `true` / `true`. Vitest: `false` / `true`.
   * research: track-01 L220, track-07 L472
   */
  readonly obsolete: { readonly failLocal: boolean; readonly failCI: boolean }
  /** Snapshot update mode in CI. Jest: `none`. Vitest: `none`. research: track-01 L220, track-07 L473 */
  readonly ciUpdate: 'new' | 'none'
  /** An environment variable that turns on snapshot updates, or `null`. Jest: `null`. Vitest: `'UPDATE_SNAPSHOT'`. research: track-07 L473 */
  readonly updateEnvVar: string | null
  /** How a thrown error is stored by `toThrowErrorMatchingSnapshot`. Jest: `message`. Vitest: `error`. research: track-07 L470 */
  readonly throwErrorBody: 'message' | 'error'
  /**
   * Inline snapshot layout: indentation, and whether Prettier formats the edit.
   * Jest: `column0`, Prettier from `prettierPath`. Vitest: `call`, none. research: track-07 L471
   */
  readonly inline: { readonly indent: 'column0' | 'call'; readonly formatter: 'prettier' | 'none' }
  /** Custom snapshot path resolver, or `null` for `<dir>/<dirName>/<file><extension>`. Jest: `snapshotResolver`. Vitest: `resolveSnapshotPath`. research: track-07 L475 */
  readonly resolvePath: Behaviour<ResolveSnapshotPath> | null
}
