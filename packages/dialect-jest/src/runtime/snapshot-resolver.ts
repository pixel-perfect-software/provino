// `snapshot.resolverFactory` (B23d B1): jest-snapshot 30.5.2's `createCustomSnapshotResolver`
// (`SnapshotResolver.ts` L79-L131), rebuilt. The worker hands it the project's resolver module as
// its file registry loaded it (the project's transform applied, as `createTranspilingRequire`
// does); it checks the three members and that the two functions invert each other, with Jest's
// texts. Jest prints both in bold (chalk); here they are plain.
import type { SnapshotResolver, SnapshotResolverFactory } from '@provino/types'

/**
 * jest-util's `interopRequireDefault(require(path)).default` (`createCustomSnapshotResolver`
 * L86-L88), over what an `import()` of the module gave: a namespace, whose `default` is what
 * Jest's `.default` is. A module with no `default` has none for Jest either (an ES module with
 * named exports only), and `undefined` comes out, as it does there; the checks below then read a
 * property of it and throw the engine's own `TypeError`, as Jest's do. Under the `node`
 * interop a CommonJS module's `default` is its `exports`, and one that set `__esModule` keeps
 * its own `default`.
 */
function defaultOf(exports: unknown): unknown {
  const inner: unknown =
    typeof exports === 'object' && exports !== null ? Reflect.get(exports, 'default') : undefined
  if (typeof inner === 'object' && inner !== null && Reflect.get(inner, '__esModule') === true) {
    return Reflect.get(inner, 'default')
  }
  return inner
}

/** `mustImplement` (L111-L115). */
function mustImplement(propName: string, requiredType: string): string {
  return `Custom snapshot resolver must implement a \`${propName}\` as a ${requiredType}.\nDocumentation: https://jestjs.io/docs/configuration#snapshotresolver-string`
}

/** What the project's module has: Jest calls its two functions with the snapshot extension. */
interface CustomResolver {
  resolveSnapshotPath(testPath: string, extension: string): string
  resolveTestPath(snapshotPath: string, extension: string): string
  readonly testPathForConsistencyCheck: string
}

const MEMBERS: readonly (readonly [keyof CustomResolver, string])[] = [
  ['resolveSnapshotPath', 'function'],
  ['resolveTestPath', 'function'],
  ['testPathForConsistencyCheck', 'string'],
]

/**
 * Builds the Jest resolver of a project's `snapshotResolver` module. Throws Jest's `TypeError`
 * for a missing member and its `Error` for functions that don't invert each other.
 * @public
 */
export const jestSnapshotResolver: SnapshotResolverFactory = (
  exports: unknown,
  extension: string,
): SnapshotResolver => {
  const custom = defaultOf(exports) as CustomResolver
  for (const [propName, requiredType] of MEMBERS) {
    if (typeof custom[propName] !== requiredType) {
      throw new TypeError(mustImplement(propName, requiredType))
    }
  }
  const resolver: SnapshotResolver = {
    resolveSnapshotPath: (testPath) => custom.resolveSnapshotPath(testPath, extension),
    resolveTestPath: (snapshotPath) => custom.resolveTestPath(snapshotPath, extension),
    testPathForConsistencyCheck: custom.testPathForConsistencyCheck,
  }
  // `verifyConsistentTransformations` (L117-L131).
  const { testPathForConsistencyCheck } = resolver
  const resolvedTestPath = resolver.resolveTestPath(
    resolver.resolveSnapshotPath(testPathForConsistencyCheck),
  )
  if (resolvedTestPath !== testPathForConsistencyCheck) {
    throw new Error(
      `Custom snapshot resolver functions must transform paths consistently, i.e. expects resolveTestPath(resolveSnapshotPath('${testPathForConsistencyCheck}')) === ${resolvedTestPath}`,
    )
  }
  return resolver
}
