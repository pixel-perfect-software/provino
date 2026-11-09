import type { JsonValue } from '../clone-safe.ts'
import type { SnapshotSerializer } from '../extensions.ts'
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
 * A snapshot serializer in pretty-format's old shape: `print` instead of `serialize`
 * (`jest-serializer-vue` is one).
 * @public
 */
export interface LegacySnapshotSerializer {
  test(value: unknown): boolean
  print(...rest: never[]): string
}

/**
 * A pretty-format plugin for snapshots, in either shape.
 * @public
 */
export type SnapshotPlugin = SnapshotSerializer | LegacySnapshotSerializer

/**
 * What a dialect's printer is asked to serialize with.
 * @public
 */
export interface SnapshotSerializeOptions {
  /**
   * The pretty-format options: `escapeString`, `printBasicPrototype`, `maxOutputLength` (left out
   * when the policy has none) and whatever else `snapshotFormat` sets.
   */
  readonly format: Readonly<Record<string, unknown>>
  /** Project and test serializers, the one added last first. The printer tries its own after them. */
  readonly plugins: readonly SnapshotPlugin[]
}

/**
 * What a snapshot matcher knows about the call when it needs a message.
 * @public
 */
export interface SnapshotMessageInfo {
  readonly matcherName: string
  readonly isInline: boolean
  /** The hint, or `''`. */
  readonly hint: string
  /** The test's full name, without the hint. */
  readonly currentTestName: string
  /** The snapshot's key in the `.snap` file. */
  readonly key: string
  /** The 1-based count of this snapshot in its test. */
  readonly count: number
  /** Whether diffs show every line. */
  readonly expand: boolean
  /** The stored snapshot, without the extra line breaks; `undefined` when there is none. */
  readonly expected: string | undefined
  /** The received value, serialized, without the extra line breaks. */
  readonly actual: string
  readonly received: unknown
  /** The property matchers, when the call had them. */
  readonly properties?: object
}

/**
 * The text of a failed snapshot matcher: every word comes from the dialect.
 * @public
 */
export interface SnapshotMessages {
  /** A stored snapshot that differs from the received value. */
  mismatch(info: SnapshotMessageInfo): string
  /** No stored snapshot, and the update mode doesn't write one (CI). */
  notWritten(info: SnapshotMessageInfo): string
  /** The received object doesn't match the property matchers. */
  propertiesMismatch(info: SnapshotMessageInfo): string
}

/**
 * A dialect's snapshot engine: its pretty-format with its own built-in plugins, and its words.
 * @public
 */
export interface SnapshotPrinter {
  /** Serializes with the engine's pretty-format. The caller adds the extra line breaks. */
  serialize(value: unknown, options: SnapshotSerializeOptions): string
  readonly messages: SnapshotMessages
}

/**
 * Returns the dialect's snapshot printer (`@provino/snapshot` loads it once per worker).
 * @public
 */
export type SnapshotPrinterFactory = () => SnapshotPrinter

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
    /**
     * The other pretty-format options a project's `snapshotFormat` sets (`indent`, `maxDepth`,
     * `min`, ...), passed to the printer as they are. Both dialects: none. Provino's own key.
     */
    readonly extra: Readonly<Record<string, JsonValue>>
  }
  /** Snapshot serializer modules, each with a default-exported pretty-format plugin. Jest: user list. Vitest: user list. research: track-01 L219 */
  readonly serializers: readonly string[]
  /**
   * Whether obsolete snapshots fail the run, locally (update mode `new`) and when nothing may be
   * written (`none`, CI); a run that rewrites (`all`, `-u`) never fails on them. Track 1 lists
   * `report` for both; Track 7's detail is used. Jest: `true` / `true`. Vitest: `false` / `true`.
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
  /**
   * The dialect's snapshot printer (its pretty-format and its messages), or `null` for none: a
   * snapshot matcher then fails with `SNAPSHOT_NO_PRINTER`. Jest: `pretty-format` 30.5. Vitest:
   * `@vitest/pretty-format` 5.0. Provino's own key.
   */
  readonly printer: Behaviour<SnapshotPrinterFactory> | null
  /** Custom snapshot path resolver, or `null` for `<dir>/<dirName>/<file><extension>`. Jest: `snapshotResolver`. Vitest: `resolveSnapshotPath`. research: track-07 L475 */
  readonly resolvePath: Behaviour<ResolveSnapshotPath> | null
}
